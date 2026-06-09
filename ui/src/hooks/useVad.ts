import { useEffect, useRef, useState } from "react";
import { MicVAD } from "@ricky0123/vad-web";

export type VadState = "idle" | "loading" | "listening" | "speaking" | "error";

export interface UseVadOptions {
  onSpeechEnd: (audio: Float32Array) => void;
  silenceMs?: number;
  enabled: boolean;
}

export function useVad(opts: UseVadOptions) {
  const [state, setState] = useState<VadState>("idle");
  const vadRef = useRef<MicVAD | null>(null);
  const onSpeechEndRef = useRef(opts.onSpeechEnd);
  // silenceMs is read once on mount; changes after that are ignored. We hold
  // it in a ref so the init effect doesn't list it as a dep and re-create the
  // VAD whenever the caller passes a new number.
  const silenceMsRef = useRef(opts.silenceMs ?? 1200);

  // Keep the latest callback without retriggering the init effect.
  useEffect(() => {
    onSpeechEndRef.current = opts.onSpeechEnd;
  }, [opts.onSpeechEnd]);

  useEffect(() => {
    if (!opts.enabled) {
      setState("idle");
      return;
    }
    let cancelled = false;
    setState("loading");

    MicVAD.new({
      onSpeechStart: () => {
        if (cancelled) return;
        setState("speaking");
      },
      onSpeechEnd: (audio: Float32Array) => {
        if (cancelled) return;
        setState("listening");
        onSpeechEndRef.current(audio);
      },
      onVADMisfire: () => {
        if (cancelled) return;
        setState("listening");
      },
      // Tuned up from the library defaults (0.5/0.35) after FRE-1296 field
      // testing: phone mics in a normal room kept tripping the VAD on
      // background noise, spawning a turn (and a full agent run) every few
      // seconds. minSpeechMs discards blips shorter than half a second.
      positiveSpeechThreshold: 0.7,
      negativeSpeechThreshold: 0.55,
      minSpeechMs: 500,
      redemptionMs: silenceMsRef.current,
      baseAssetPath: "/vad/",
      onnxWASMBasePath: "/vad/",
    })
      .then((vad) => {
        if (cancelled) {
          vad.destroy();
          return;
        }
        vadRef.current = vad;
        vad.start();
        setState("listening");
      })
      .catch((e) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("[useVad] init failed", e);
        setState("error");
      });

    return () => {
      cancelled = true;
      vadRef.current?.destroy();
      vadRef.current = null;
    };
  }, [opts.enabled]);

  return {
    state,
    pause: () => vadRef.current?.pause(),
    resume: () => vadRef.current?.start(),
  };
}
