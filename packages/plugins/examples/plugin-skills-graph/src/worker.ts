import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup() {
    // Skills Graph is a static UI plugin; no worker behavior required.
  },

  async onHealth() {
    return { status: "ok", message: "Skills Graph plugin running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
