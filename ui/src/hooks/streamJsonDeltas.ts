/**
 * Incremental stream-json (claude CLI --output-format stream-json) parser that
 * yields ONLY assistant-visible text. Buffers partial lines across WS chunks.
 * Mirrors the event shapes handled by fetchFinalAssistantText in VoiceMode.tsx;
 * keep the two in sync if run-log format changes.
 *
 * WARNING - partial-messages double-speak hazard: if the CLI is ever invoked
 * with --include-partial-messages, assistant text will arrive via BOTH
 * content_block_delta text_delta events (streaming) AND the assistant message
 * block at the end of the turn. The extractor currently emits both, which
 * would cause every sentence to be spoken twice. If that flag is ever enabled,
 * add a seenTextDelta boolean and suppress assistant-block text extraction
 * after any text_delta has been seen in the same run.
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
