import { cn } from "@/lib/utils";
import { Mic, MicOff, Square, X } from "lucide-react";

export interface VoiceControlsProps {
  muted: boolean;
  isSpeaking: boolean;
  onEnd(): void;
  onToggleMute(): void;
  onStop(): void;
  className?: string;
}

/**
 * Top control bar for the /voice page.
 *
 * Layout: [End] ............... [Mute] [Stop]
 *
 * All buttons are sized to 44pt min-tap targets (h-11 w-11 = 44px) to satisfy
 * iOS HIG and Material a11y guidance on mobile.
 */
export function VoiceControls({
  muted,
  isSpeaking,
  onEnd,
  onToggleMute,
  onStop,
  className,
}: VoiceControlsProps) {
  const buttonBase =
    "inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none";

  return (
    <div
      className={cn("flex items-center justify-between gap-2 px-4 py-3", className)}
      data-testid="voice-controls"
    >
      <button
        type="button"
        onClick={onEnd}
        aria-label="End voice session"
        data-testid="voice-control-end"
        className={cn(
          buttonBase,
          "border-destructive/40 text-destructive hover:bg-destructive/10",
        )}
      >
        <X className="h-5 w-5" />
      </button>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleMute}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          data-testid="voice-control-mute"
          className={cn(buttonBase, muted && "bg-muted")}
        >
          {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>

        <button
          type="button"
          onClick={onStop}
          disabled={!isSpeaking}
          aria-label="Stop playback"
          data-testid="voice-control-stop"
          className={buttonBase}
        >
          <Square className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
