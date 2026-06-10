/**
 * Incremental stream-json (claude CLI --output-format stream-json) parser that
 * yields ONLY assistant-visible text. Buffers partial lines across WS chunks.
 * Mirrors the event shapes handled by fetchFinalAssistantText in VoiceMode.tsx;
 * keep the two in sync if run-log format changes.
 */
export interface DeltaExtractor {
  push(chunk: string): string[];
}

export function createDeltaExtractor(): DeltaExtractor {
  let buf = "";
  return {
    push(chunk: string): string[] {
      buf += chunk;
      const out: string[] = [];
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const lineStr = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!lineStr.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(lineStr);
        } catch {
          continue;
        }
        if (
          obj?.type === "stream_event" &&
          obj.event?.type === "content_block_delta" &&
          obj.event.delta?.type === "text_delta" &&
          typeof obj.event.delta.text === "string"
        ) {
          out.push(obj.event.delta.text);
        } else if (obj?.type === "assistant" && Array.isArray(obj.message?.content)) {
          for (const block of obj.message.content) {
            if (block?.type === "text" && typeof block.text === "string") {
              out.push(block.text);
            }
          }
        }
      }
      return out;
    },
  };
}
