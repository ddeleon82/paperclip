import { cn } from "@/lib/utils";
type MutablePhase = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceOrbProps {
  /**
   * Visible phase. `muted` and `error` are rendered as static dim variants by
   * the caller. This component only renders the four mutable phases plus a
   * generic dim fallback.
   */
  phase: MutablePhase | "muted" | "error";
  className?: string;
}

const PHASE_LABEL: Record<VoiceOrbProps["phase"], string> = {
  idle: "Idle",
  listening: "Listening...",
  thinking: "Thinking...",
  speaking: "Speaking...",
  muted: "Muted",
  error: "Error",
};

/**
 * Animated orb whose visual mirrors the voice session machine phase.
 *
 * TODO(fre-968): Tie the speaking-state amplitude to AnalyserNode.getByteFrequencyData
 * once useStreamingTts exposes the underlying HTMLAudioElement. For v1 the
 * speaking state is a CSS-only fast pulse - good enough to ship and visually
 * communicate the right idea.
 */
export function VoiceOrb({ phase, className }: VoiceOrbProps) {
  const baseClasses =
    "relative flex h-32 w-32 items-center justify-center rounded-full transition-colors duration-300";

  // Phase-specific surface + animation class.
  const phaseClasses = (() => {
    switch (phase) {
      case "listening":
        return "bg-primary/70 voice-orb-pulse-soft";
      case "thinking":
        return "bg-primary/60 voice-orb-rotate";
      case "speaking":
        return "bg-primary voice-orb-pulse-fast";
      case "muted":
        return "bg-muted-foreground/30";
      case "error":
        return "bg-destructive/40";
      case "idle":
      default:
        return "bg-muted-foreground/30";
    }
  })();

  return (
    <div className={cn("flex flex-col items-center gap-4", className)}>
      <div
        role="img"
        aria-label={`voice orb ${phase}`}
        data-testid="voice-orb"
        data-phase={phase}
        className={cn(baseClasses, phaseClasses)}
      >
        {/* Inner highlight - kept lightweight so it does not interfere with the
            pulse animation on the outer surface. */}
        <div className="h-16 w-16 rounded-full bg-white/10" />
      </div>
      <p className="text-sm text-muted-foreground" data-testid="voice-orb-label">
        {PHASE_LABEL[phase]}
      </p>
    </div>
  );
}
