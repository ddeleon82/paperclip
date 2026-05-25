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

  // Keep the latest callback without retriggering the init effect.
  useEffect(() => {
    onSpeechEndRef.current = opts.onSpeechEnd;
  }, [opts.onSpeechEnd]);

  const silenceMs = opts.silenceMs ?? 1200;

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
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      redemptionMs: silenceMs,
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
  }, [opts.enabled, silenceMs]);

  return {
    state,
    pause: () => vadRef.current?.pause(),
    resume: () => vadRef.current?.start(),
  };
}
