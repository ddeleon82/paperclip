import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  buildHeartbeatRunFailureComment,
  readAgentCheckpointNextStep,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });
});

describe("buildHeartbeatRunFailureComment", () => {
  it("describes a timed_out run with duration, error code, and checkpoint next step", () => {
    const comment = buildHeartbeatRunFailureComment({
      outcome: "timed_out",
      durationMs: 30 * 60 * 1000 + 1000,
      errorCode: "timeout",
      errorMessage: "Timed out",
      checkpointNextStep: "verify-deploy",
      recoveryWakeQueued: true,
    });

    expect(comment).not.toBeNull();
    expect(comment).toContain("timed out");
    expect(comment).toContain("30m 1s");
    expect(comment).toContain("`timeout`");
    expect(comment).toContain("`verify-deploy`");
    expect(comment).toContain("recovery wake");
  });

  it("describes a failed run and notes when no recovery wake was queued", () => {
    const comment = buildHeartbeatRunFailureComment({
      outcome: "failed",
      durationMs: 42_000,
      errorCode: "adapter_failed",
      errorMessage: "adapter exited with code 1",
      checkpointNextStep: null,
      recoveryWakeQueued: false,
    });

    expect(comment).not.toBeNull();
    expect(comment).toContain("failed");
    expect(comment).toContain("42s");
    expect(comment).toContain("`adapter_failed`");
    expect(comment).toContain("adapter exited with code 1");
    expect(comment).not.toContain("checkpoint");
    expect(comment).toContain("No recovery wake queued");
  });

  it("truncates long error messages", () => {
    const comment = buildHeartbeatRunFailureComment({
      outcome: "failed",
      durationMs: 1000,
      errorCode: "adapter_failed",
      errorMessage: "x".repeat(2000),
      checkpointNextStep: null,
      recoveryWakeQueued: true,
    });

    expect(comment).not.toBeNull();
    expect(comment!.length).toBeLessThan(1500);
  });

  it("returns null for succeeded and cancelled outcomes (no comment spam)", () => {
    expect(
      buildHeartbeatRunFailureComment({
        outcome: "succeeded",
        durationMs: 1000,
        errorCode: null,
        errorMessage: null,
        checkpointNextStep: null,
        recoveryWakeQueued: false,
      }),
    ).toBeNull();
    expect(
      buildHeartbeatRunFailureComment({
        outcome: "cancelled",
        durationMs: 1000,
        errorCode: "cancelled",
        errorMessage: null,
        checkpointNextStep: null,
        recoveryWakeQueued: false,
      }),
    ).toBeNull();
  });

  it("tolerates missing duration and error fields", () => {
    const comment = buildHeartbeatRunFailureComment({
      outcome: "timed_out",
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      checkpointNextStep: null,
      recoveryWakeQueued: true,
    });

    expect(comment).not.toBeNull();
    expect(comment).toContain("timed out");
  });
});

describe("readAgentCheckpointNextStep", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pp-checkpoint-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads next_step from an in-progress checkpoint", async () => {
    await mkdir(join(root, "FRE-1361"));
    await writeFile(
      join(root, "FRE-1361", "checkpoint.json"),
      JSON.stringify({ status: "in_progress", next_step: "task-5-verify" }),
    );

    await expect(readAgentCheckpointNextStep("FRE-1361", root)).resolves.toBe("task-5-verify");
  });

  it("returns null when the checkpoint file is missing", async () => {
    await expect(readAgentCheckpointNextStep("FRE-9999", root)).resolves.toBeNull();
  });

  it("returns null for malformed JSON, empty next_step, and missing identifier", async () => {
    await mkdir(join(root, "FRE-1"));
    await writeFile(join(root, "FRE-1", "checkpoint.json"), "not json{");
    await expect(readAgentCheckpointNextStep("FRE-1", root)).resolves.toBeNull();

    await mkdir(join(root, "FRE-2"));
    await writeFile(join(root, "FRE-2", "checkpoint.json"), JSON.stringify({ next_step: "  " }));
    await expect(readAgentCheckpointNextStep("FRE-2", root)).resolves.toBeNull();

    await expect(readAgentCheckpointNextStep(null, root)).resolves.toBeNull();
    await expect(readAgentCheckpointNextStep("", root)).resolves.toBeNull();
  });

  it("rejects identifiers with path traversal characters", async () => {
    await expect(readAgentCheckpointNextStep("../etc", root)).resolves.toBeNull();
    await expect(readAgentCheckpointNextStep("a/b", root)).resolves.toBeNull();
  });
});
