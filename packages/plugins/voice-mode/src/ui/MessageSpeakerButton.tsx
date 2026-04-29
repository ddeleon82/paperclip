/**
 * MessageSpeakerButton — stub for Task 12.
 *
 * Renders a TTS play/stop button next to an assistant message.
 * Full implementation deferred to Task 12.
 *
 * Slot type: `commentAnnotation` (entity: comment)
 * The host passes the comment body through `context.entityId`; the full text
 * will be resolved via a `voice.audio.get` action in the Task 12 implementation.
 */
import React from "react";
import type { PluginCommentAnnotationProps } from "@paperclipai/plugin-sdk/ui";

export function MessageSpeakerButton(_props: PluginCommentAnnotationProps) {
  // TODO (Task 12): implement TTS play/stop for comment text
  return null;
}
