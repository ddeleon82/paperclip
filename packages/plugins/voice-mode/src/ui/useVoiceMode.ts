import { useState, useEffect, useRef, useCallback } from "react";

const LS_KEY = "paperclip:voiceMode:enabled";
const PUSH_TO_TALK_MIN_MS = 200;

export interface UseVoiceModeResult {
  enabled: boolean;
  toggle(): void;
  isRecording: boolean;
  isSpeaking: boolean;
  startRecording(): Promise<void>;
  stopRecording(): Promise<Blob | null>;
  playAudio(mp3Blob: Blob): Promise<void>;
  stopSpeaking(): void;
}

export function useVoiceMode(): UseVoiceModeResult {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Refs so event handlers always see current values without stale closures
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const keydownTimeRef = useRef<number | null>(null);
  const isRecordingRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const enabledRef = useRef(enabled);

  // Keep refs in sync
  enabledRef.current = enabled;
  isRecordingRef.current = isRecording;
  isSpeakingRef.current = isSpeaking;

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(LS_KEY, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const startRecording = useCallback(async (): Promise<void> => {
    if (isRecordingRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder) {
        resolve(null);
        return;
      }
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        setIsRecording(false);
        // Stop all tracks
        const stream = streamRef.current;
        if (stream) {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        mediaRecorderRef.current = null;
        const blob = chunks.length > 0 ? new Blob(chunks, { type: "audio/webm" }) : null;
        resolve(blob);
      };
      recorder.stop();
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setIsSpeaking(false);
  }, []);

  const playAudio = useCallback(async (mp3Blob: Blob): Promise<void> => {
    // Stop any current audio first
    stopSpeaking();
    const url = URL.createObjectURL(mp3Blob);
    objectUrlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    setIsSpeaking(true);
    return new Promise<void>((resolve) => {
      audio.onended = () => {
        URL.revokeObjectURL(url);
        objectUrlRef.current = null;
        audioRef.current = null;
        setIsSpeaking(false);
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        objectUrlRef.current = null;
        audioRef.current = null;
        setIsSpeaking(false);
        resolve();
      };
      audio.play().catch(() => {
        setIsSpeaking(false);
        resolve();
      });
    });
  }, [stopSpeaking]);

  // Spacebar push-to-talk handler
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!target || !(target instanceof Element)) return false;
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea") return true;
      if ((target as HTMLElement).isContentEditable) return true;
      return false;
    };

    const handleKeydown = async (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      if (e.code !== "Space") return;
      if (isEditableTarget(e.target)) return;
      if (e.repeat) return;

      // If speaking, stop speaking and consume
      if (isSpeakingRef.current) {
        e.preventDefault();
        // stopSpeaking is stable via useCallback
        return;
      }

      // Start push-to-talk
      if (!isRecordingRef.current) {
        e.preventDefault();
        keydownTimeRef.current = Date.now();
        try {
          await startRecording();
        } catch {
          // ignore (e.g. permission denied)
        }
      }
    };

    const handleKeyup = async (e: KeyboardEvent) => {
      if (!enabledRef.current) return;
      if (e.code !== "Space") return;
      if (isEditableTarget(e.target)) return;

      if (isSpeakingRef.current) {
        e.preventDefault();
        stopSpeaking();
        return;
      }

      if (isRecordingRef.current) {
        e.preventDefault();
        const held = keydownTimeRef.current != null ? Date.now() - keydownTimeRef.current : 0;
        keydownTimeRef.current = null;
        if (held >= PUSH_TO_TALK_MIN_MS) {
          const blob = await stopRecording();
          if (blob) {
            window.dispatchEvent(new CustomEvent("voice-mode:transcribe", { detail: blob }));
          }
        } else {
          // Too short - discard
          await stopRecording();
        }
      }
    };

    window.addEventListener("keydown", handleKeydown as EventListener);
    window.addEventListener("keyup", handleKeyup as EventListener);
    return () => {
      window.removeEventListener("keydown", handleKeydown as EventListener);
      window.removeEventListener("keyup", handleKeyup as EventListener);
    };
  }, [startRecording, stopRecording, stopSpeaking]);

  return {
    enabled,
    toggle,
    isRecording,
    isSpeaking,
    startRecording,
    stopRecording,
    playAudio,
    stopSpeaking,
  };
}
