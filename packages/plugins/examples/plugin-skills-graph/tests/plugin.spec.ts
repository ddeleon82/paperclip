import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin-skills-graph", () => {
  it("setup runs without errors and onHealth reports ok", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });
});
