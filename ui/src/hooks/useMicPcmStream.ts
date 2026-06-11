import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Pure resampling utility (unit-tested, no DOM dependency)
// ---------------------------------------------------------------------------

/**
 * Linearly-interpolate resample `input` from `inputRate` down to 16 000 Hz,
 * clamp each sample to [-1, 1], and scale to signed 16-bit integer range.
 *
 * Length of the returned buffer = ceil(input.length * 16000 / inputRate).
 * When inputRate === 16000 the function is a pure scale-and-clamp pass.
 */
export function downsampleTo16kPcm16(
  input: Float32Array,
  inputRate: number,
): Int16Array {
  const TARGET = 16000;
  if (input.length === 0) return new Int16Array(0);

  const ratio = inputRate / TARGET;
  const outLen = Math.ceil(input.length / ratio);
  const out = new Int16Array(outLen);

  for (let i = 0; i < outLen; i++) {
    // Position in the input array that corresponds to output sample i
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;

    // Linear interpolation
    let sample = input[lo] * (1 - frac) + input[hi] * frac;

    // Clamp to [-1, 1]
    if (sample > 1) sample = 1;
    if (sample < -1) sample = -1;

    // Scale to Int16 range; positive side is [0..32767], negative [-32768..0]
    out[i] = sample >= 0
      ? Math.floor(sample * 32767)
      : Math.floor(sample * 32768);
  }

  return out;
}

// ---------------------------------------------------------------------------
// AudioWorklet source (loaded from inline Blob URL — no static asset needed)
// ---------------------------------------------------------------------------

const WORKLET_CODE = /* js */ `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // Transfer the underlying buffer for zero-copy
      const copy = new Float32Array(channel);
      this.port.postMessage({ samples: copy }, [copy.buffer]);
    }
    return true; // keep processor alive
  }
}
registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
`;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

type MicState = "idle" | "capturing" | "denied" | "error";

export interface UseMicPcmStreamOptions {
  /** Called with each ~250 ms PCM16 chunk at 16 000 Hz. */
  onChunk: (pcm: Int16Array) => void;
  enabled: boolean;
}

export interface UseMicPcmStreamResult {
  state: MicState;
  error?: string;
}

/**
 * Captures microphone audio and emits ~250 ms PCM16 chunks at 16 kHz via
 * `onChunk`. Uses AudioWorklet where available, falls back to
 * ScriptProcessorNode (older iOS Safari).
 */
export function useMicPcmStream(
  opts: UseMicPcmStreamOptions,
): UseMicPcmStreamResult {
  const { onChunk, enabled } = opts;

  const [state, setState] = useState<MicState>("idle");
  const [error, setError] = useState<string | undefined>();

  // Stable ref so the capture callbacks always call the latest onChunk without
  // needing to re-create the AudioContext on every render.
  const onChunkRef = useRef(onChunk);
  onChunkRef.current = onChunk;

  // Cleanup handle
  const cleanupRef = useRef<(() => void) | null>(null);

  const startCapture = useCallback(async () => {
    setState("capturing");
    setError(undefined);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")
      ) {
        setState("denied");
      } else {
        setState("error");
      }
      setError(msg);
      return;
    }

    const ctx = new AudioContext();
    const nativeRate = ctx.sampleRate;
    const source = ctx.createMediaStreamSource(stream);

    // ~250 ms worth of input frames at the native sample rate
    const BATCH_MS = 250;
    const batchCapacity = Math.ceil((nativeRate * BATCH_MS) / 1000);
    let batchBuf: Float32Array[] = [];
    let batchLen = 0;

    const flush = () => {
      if (batchLen === 0) return;
      // Concatenate accumulated frames
      const merged = new Float32Array(batchLen);
      let offset = 0;
      for (const chunk of batchBuf) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      batchBuf = [];
      batchLen = 0;
      onChunkRef.current(downsampleTo16kPcm16(merged, nativeRate));
    };

    const accumulate = (samples: Float32Array) => {
      batchBuf.push(samples);
      batchLen += samples.length;
      if (batchLen >= batchCapacity) flush();
    };

    let cleanup: () => void;

    if (ctx.audioWorklet) {
      // AudioWorklet path
      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);

      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }

      const workletNode = new AudioWorkletNode(ctx, "pcm-capture-processor");
      workletNode.port.onmessage = (ev: MessageEvent<{ samples: Float32Array }>) => {
        accumulate(ev.data.samples);
      };
      source.connect(workletNode);
      // Connect to destination to keep the graph alive in some browsers, but
      // mute it so we don't feed back captured audio.
      workletNode.connect(ctx.destination);

      cleanup = () => {
        flush();
        workletNode.disconnect();
        source.disconnect();
        void ctx.close();
        stream.getTracks().forEach((t) => t.stop());
      };
    } else {
      // ScriptProcessorNode fallback (deprecated but still works on older iOS)
      const bufferSize = 4096;
      const spNode = ctx.createScriptProcessor(bufferSize, 1, 1);
      spNode.onaudioprocess = (ev: AudioProcessingEvent) => {
        const channel = ev.inputBuffer.getChannelData(0);
        accumulate(new Float32Array(channel));
      };
      source.connect(spNode);
      spNode.connect(ctx.destination);

      cleanup = () => {
        flush();
        spNode.disconnect();
        source.disconnect();
        void ctx.close();
        stream.getTracks().forEach((t) => t.stop());
      };
    }

    cleanupRef.current = cleanup;
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Stop any active capture
      cleanupRef.current?.();
      cleanupRef.current = null;
      setState("idle");
      setError(undefined);
      return;
    }

    void startCapture();

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [enabled, startCapture]);

  return { state, error };
}
