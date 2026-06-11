/**
 * Function declarations for the voice gateway Gemini Live session (FRE-1296).
 *
 * Each export matches the shape expected by LiveClient.connect({ tools }).
 */

export interface GatewayFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

/**
 * Dispatch the user's request to Conrad as a background task.
 * Returns a runId that can be polled with check_run.
 */
export const DISPATCH_TO_CONRAD: GatewayFunctionDeclaration = {
  name: "dispatch_to_conrad",
  description:
    "Send the user's request to Conrad as a background task. Returns a runId. Use for ANY substantive request.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The user's full request, verbatim or lightly cleaned up for clarity.",
      },
    },
    required: ["prompt"],
  },
};

/**
 * Check whether a previously dispatched Conrad run has finished.
 */
export const CHECK_RUN: GatewayFunctionDeclaration = {
  name: "check_run",
  description:
    "Check whether a previously dispatched Conrad run has finished. Pass the runId returned by dispatch_to_conrad.",
  parameters: {
    type: "object",
    properties: {
      runId: {
        type: "string",
        description: "The run identifier returned by dispatch_to_conrad.",
      },
    },
    required: ["runId"],
  },
};

/**
 * Cheap read-only snapshot of the Paperclip board.
 */
export const BOARD_SNAPSHOT: GatewayFunctionDeclaration = {
  name: "board_snapshot",
  description:
    "Cheap read-only summary of the Paperclip board: counts by status and the most recently updated issues.",
  parameters: {
    type: "object",
    properties: {},
  },
};

/** All three declarations in a flat array, ready to pass to LiveClient.connect(). */
export const GATEWAY_TOOL_DEFS: GatewayFunctionDeclaration[] = [
  DISPATCH_TO_CONRAD,
  CHECK_RUN,
  BOARD_SNAPSHOT,
];
