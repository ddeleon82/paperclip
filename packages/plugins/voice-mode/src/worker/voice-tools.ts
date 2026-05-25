import type { PluginIssuesClient } from "@paperclipai/plugin-sdk";

export type VoiceToolName = "create_issue";

export type VoiceToolInput =
  | {
      name: "create_issue";
      companyId: string;
      title: string;
      description?: string;
      projectId?: string;
    };

export type VoiceToolResult =
  | { ok: true; toolName: "create_issue"; issueId: string; issueTitle: string }
  | { ok: false; toolName: string; error: string };

export interface VoiceToolHostApi {
  issues: Pick<PluginIssuesClient, "create">;
}

/**
 * JSON schema for the `create_issue` tool, suitable to pass to Claude as a
 * tool definition. The voice agent calls this when Dom asks for an issue.
 */
export const CREATE_ISSUE_TOOL_SCHEMA = {
  name: "create_issue",
  description:
    "Create a new issue when the user explicitly asks for one. Use this only when the user says \"create an issue\" or similar. Provide a clear, short title (under 80 chars) and a one-sentence description.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title under 80 chars" },
      description: { type: "string", description: "One-sentence description of the issue" },
      projectId: { type: "string", description: "Project UUID. If omitted, the host will use the company default project." },
    },
    required: ["title"],
  },
} as const;

/**
 * Dispatch a voice-agent tool call. Never throws - failures are returned as
 * structured `{ ok: false, error }` so the agent can verbalize them.
 */
export async function dispatchVoiceTool(args: {
  hostApi: VoiceToolHostApi;
  input: VoiceToolInput;
}): Promise<VoiceToolResult> {
  const { hostApi, input } = args;
  try {
    switch (input.name) {
      case "create_issue": {
        if (!input.title?.trim()) {
          return { ok: false, toolName: input.name, error: "Title is required" };
        }
        const issue = await hostApi.issues.create({
          companyId: input.companyId,
          title: input.title.trim(),
          description: input.description?.trim(),
          projectId: input.projectId,
        });
        return {
          ok: true,
          toolName: "create_issue",
          issueId: issue.id,
          issueTitle: issue.title,
        };
      }
      default: {
        const _exhaustive: never = input;
        void _exhaustive;
        return { ok: false, toolName: String((input as { name?: string }).name), error: "Unknown tool" };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, toolName: input.name, error: message };
  }
}
