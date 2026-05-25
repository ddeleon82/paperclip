import { describe, it, expect, vi } from "vitest";
import { dispatchVoiceTool, CREATE_ISSUE_TOOL_SCHEMA } from "./voice-tools.js";

describe("CREATE_ISSUE_TOOL_SCHEMA", () => {
  it("requires title and exposes optional description / projectId", () => {
    expect(CREATE_ISSUE_TOOL_SCHEMA.name).toBe("create_issue");
    expect(CREATE_ISSUE_TOOL_SCHEMA.input_schema.required).toEqual(["title"]);
    expect(CREATE_ISSUE_TOOL_SCHEMA.input_schema.properties).toHaveProperty("title");
    expect(CREATE_ISSUE_TOOL_SCHEMA.input_schema.properties).toHaveProperty("description");
    expect(CREATE_ISSUE_TOOL_SCHEMA.input_schema.properties).toHaveProperty("projectId");
  });
});

describe("dispatchVoiceTool create_issue", () => {
  it("returns ok with issueId/title on success", async () => {
    const hostApi = {
      issues: { create: vi.fn().mockResolvedValue({ id: "issue-uuid-1", title: "Add wake word" }) },
    };
    const res = await dispatchVoiceTool({
      hostApi,
      input: {
        name: "create_issue",
        companyId: "co-1",
        title: "Add wake word",
        description: "Optional description",
        projectId: "proj-1",
      },
    });
    expect(res).toEqual({
      ok: true,
      toolName: "create_issue",
      issueId: "issue-uuid-1",
      issueTitle: "Add wake word",
    });
    expect(hostApi.issues.create).toHaveBeenCalledWith({
      companyId: "co-1",
      title: "Add wake word",
      description: "Optional description",
      projectId: "proj-1",
    });
  });

  it("trims whitespace from title and description", async () => {
    const hostApi = {
      issues: { create: vi.fn().mockResolvedValue({ id: "i-2", title: "Hello" }) },
    };
    await dispatchVoiceTool({
      hostApi,
      input: { name: "create_issue", companyId: "co-1", title: "  Hello  ", description: "  body  " },
    });
    expect(hostApi.issues.create).toHaveBeenCalledWith({
      companyId: "co-1",
      title: "Hello",
      description: "body",
      projectId: undefined,
    });
  });

  it("returns structured error when title is empty / whitespace", async () => {
    const hostApi = { issues: { create: vi.fn() } };
    const res = await dispatchVoiceTool({
      hostApi,
      input: { name: "create_issue", companyId: "co-1", title: "   " },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Title is required");
    expect(hostApi.issues.create).not.toHaveBeenCalled();
  });

  it("returns structured error when host throws (e.g. invalid project)", async () => {
    const hostApi = {
      issues: { create: vi.fn().mockRejectedValue(new Error("project not found")) },
    };
    const res = await dispatchVoiceTool({
      hostApi,
      input: { name: "create_issue", companyId: "co-1", title: "Issue", projectId: "bogus" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("project not found");
  });

  it("returns structured error when host throws non-Error", async () => {
    const hostApi = {
      issues: { create: vi.fn().mockRejectedValue("string failure") },
    };
    const res = await dispatchVoiceTool({
      hostApi,
      input: { name: "create_issue", companyId: "co-1", title: "Issue" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("string failure");
  });
});
