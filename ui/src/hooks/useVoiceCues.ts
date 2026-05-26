/**
 * useVoiceCues — small Web Audio cue generator for the /voice page.
 *
 * Two short sine-tone cues:
 *   - playMicOpen()        — a brighter ~880 Hz blip, signaling "I'm listening"
 *   - playSpeechReceived() — a darker  ~440 Hz blip, signaling "I caught that"
 *
 * No external assets. We synthesize the tones inline via an AudioContext so
 * there is nothing to bundle or fetch. The hook is best-effort: in any
 * environment without Web Audio (jsdom, SSR, locked-down browsers) the
 * returned functions are silent no-ops rather than throwing.
 *
 * Why not pre-recorded WAV files? Generating means zero bundle bloat, full
 * control over volume / duration / envelope, and no decoded-buffer warm-up
 * latency on the first cue.
 */
import { useCallback, useEffect, useRef } from "react";

const MIC_OPEN_FREQ_HZ = 880;
const SPEECH_RECEIVED_FREQ_HZ = 440;
const CUE_DURATION_S = 0.12;
const CUE_PEAK_GAIN = 0.06;

export interface VoiceCues {
  playMicOpen(): void;
  playSpeechReceived(): void;
}

function getAudioCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

export function useVoiceCues(): VoiceCues {
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    return () => {
      const ctx = ctxRef.current;
      if (ctx) {
        try {
          void ctx.close();
        } catch {
          // ignore
        }
        ctxRef.current = null;
      }
    };
  }, []);

  const playTone = useCallback((frequencyHz: number) => {
    const AudioCtor = getAudioCtor();
    if (!AudioCtor) return;
    try {
      const ctx = ctxRef.current ?? new AudioCtor();
      ctxRef.current = ctx;
      // Browsers may suspend the context until a user gesture. Resume is a
      // no-op when already running.
      if (ctx.state === "suspended") {
        void ctx.resume();
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequencyHz;

      // Quick attack + exponential decay so the cue feels like a soft "blip"
      // rather than a clipped click. Exponential ramp avoids the DC pop a
      // hard cutoff would produce.
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(CUE_PEAK_GAIN, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + CUE_DURATION_S);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + CUE_DURATION_S + 0.02);
      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch {
          // ignore
        }
      };
    } catch {
      // Any audio failure is best-effort silent — cues are non-essential UI.
    }
  }, []);

  const playMicOpen = useCallback(() => {
    playTone(MIC_OPEN_FREQ_HZ);
  }, [playTone]);

  const playSpeechReceived = useCallback(() => {
    playTone(SPEECH_RECEIVED_FREQ_HZ);
  }, [playTone]);

  return { playMicOpen, playSpeechReceived };
}
