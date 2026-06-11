// Ported from packages/plugins/voice-mode/src/worker/sentence-buffer.ts (FRE-1296).
// The plugin worker copy remains; this server-side copy exists because the
// server cannot import plugin worker source directly.

export interface SentenceBuffer {
  push(chunk: string): string[];
  flush(): string[];
}

/**
 * Streaming sentence splitter used to chunk Claude's `text_delta` output into
 * full sentences before piping into the ElevenLabs streaming TTS endpoint.
 * Keeps decimals (3.14), and only emits when terminal punctuation is followed
 * by whitespace or end-of-buffer.
 */
export function splitIntoSentences(): SentenceBuffer {
  let buf = "";
  return {
    push(chunk: string): string[] {
      buf += chunk;
      const out: string[] = [];
      // Match runs of non-terminator chars ending in `.`, `!`, or `?`.
      // `\.(?!\d)` prevents splitting on decimals like "3.14".
      // Lookahead `(?=\s|$)` ensures the sentence is followed by whitespace
      // (or end-of-buffer at flush time).
      // Match a sentence: any chars (including digit.digit decimals) up to a
      // terminal `.` not followed by a digit, or `!`/`?`, followed by space or EOL.
      // `(?:\d\.\d+)+` allows decimal numbers to pass through intact.
      const re = /(?:[^.!?]|\d\.\d+)*(?:\.(?!\d)|[!?])+(?=\s|$)/g;
      let match: RegExpExecArray | null;
      let lastEnd = 0;
      while ((match = re.exec(buf))) {
        out.push(match[0]);
        lastEnd = match.index + match[0].length;
      }
      if (lastEnd > 0) buf = buf.slice(lastEnd);
      return out;
    },
    flush(): string[] {
      const tail = buf;
      buf = "";
      return tail.trim() ? [tail] : [];
    },
  };
}
