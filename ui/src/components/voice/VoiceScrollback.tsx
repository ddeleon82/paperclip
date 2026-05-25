import { cn } from "@/lib/utils";

export interface VoiceTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface VoiceScrollbackProps {
  turns: VoiceTurn[];
  /** Max turns to render. Defaults to 6, the last N most-recent. */
  maxTurns?: number;
  className?: string;
}

/**
 * Renders the most recent N transcript turns from the active voice session.
 * Small text by design - the orb and audio are the primary surfaces, the
 * scrollback is a secondary read-back of what just happened.
 */
export function VoiceScrollback({ turns, maxTurns = 6, className }: VoiceScrollbackProps) {
  const visible = turns.slice(-maxTurns);

  if (visible.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-1 items-center justify-center text-xs text-muted-foreground/70",
          className,
        )}
        data-testid="voice-scrollback-empty"
      >
        Start talking when you are ready.
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-1 flex-col gap-2 overflow-y-auto p-4 text-xs", className)}
      data-testid="voice-scrollback"
    >
      {visible.map((turn) => (
        <div
          key={turn.id}
          data-role={turn.role}
          className={cn(
            "rounded-md px-2 py-1 leading-snug",
            turn.role === "user"
              ? "self-end bg-primary/10 text-foreground"
              : "self-start bg-muted text-muted-foreground",
          )}
        >
          {turn.text}
        </div>
      ))}
    </div>
  );
}
