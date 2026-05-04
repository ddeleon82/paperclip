import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "fandc.plugin-skills-graph",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Skills Graph",
  description:
    "Interactive knowledge graph of installed Claude skills. Adds a Skills Graph entry to the sidebar and a full-page interactive graph view.",
  author: "Freedom & Coffee",
  categories: ["ui"],
  capabilities: ["ui.sidebar.register", "ui.page.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "skills-graph-sidebar-link",
        displayName: "Skills Graph",
        exportName: "SkillsGraphSidebarLink",
      },
      {
        type: "page",
        id: "skills-graph-page",
        displayName: "Skills Graph",
        exportName: "SkillsGraphPage",
        routePath: "skills-graph",
      },
    ],
  },
};

export default manifest;
