/**
 * Plugin action client wrappers for voice-mode UI.
 *
 * `usePluginAction(key)` from @paperclipai/plugin-sdk/ui returns an async
 * callable directly (not an object with `.invoke`). Because it is a hook, these
 * wrappers are themselves hooks — call them at the component top level.
 */
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBlob(audioBase64: string, mime: string): Blob {
  const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime || "audio/mpeg" });
}

// ---------------------------------------------------------------------------
// Hook — returns stable action functions backed by the plugin bridge
// ---------------------------------------------------------------------------

export interface VoiceActions {
  /**
   * Convert a recorded audio Blob to a transcript string.
   * Calls the `voice.transcribe` worker action.
   */
  transcribeAudio(blob: Blob): Promise<{ transcript: string; audioId: string }>;

  /**
   * Synthesize speech from text and return the audio as an mp3 Blob.
   * Calls the `voice.speak` worker action.
   */
  speakText(text: string, voiceId: string): Promise<Blob>;
}

/**
 * Hook — provides voice action callables backed by the plugin bridge.
 *
 * @example
 * ```tsx
 * function VoiceControls() {
 *   const { transcribeAudio, speakText } = useVoiceActions();
 *   // ...
 * }
 * ```
 */
export function useVoiceActions(): VoiceActions {
  // usePluginAction returns a stable async callable: (params) => Promise<result>
  const transcribe = usePluginAction("voice.transcribe");
  const speak = usePluginAction("voice.speak");

  async function transcribeAudio(
    blob: Blob,
  ): Promise<{ transcript: string; audioId: string }> {
    const audioBase64 = await blobToBase64(blob);
    const result = await transcribe({
      audioBase64,
      mime: blob.type || "audio/webm",
    });
    return result as { transcript: string; audioId: string };
  }

  async function speakText(text: string, voiceId: string): Promise<Blob> {
    const result = await speak({ text, voiceId });
    const { audioBase64, mime } = result as { audioBase64: string; mime: string };
    return base64ToBlob(audioBase64, mime);
  }

  return { transcribeAudio, speakText };
}
