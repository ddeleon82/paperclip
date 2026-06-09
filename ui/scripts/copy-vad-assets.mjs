// Copies @ricky0123/vad-web's Silero ONNX model + the onnxruntime-web WASM
// runtime to ui/public/vad/ so the browser can fetch them at /vad/<name>.
// Wired as pnpm `prebuild` + `predev`. Idempotent.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const targetDir = join(here, "..", "public", "vad");
mkdirSync(targetDir, { recursive: true });

const vadSrc = join(here, "..", "node_modules", "@ricky0123", "vad-web", "dist");
const ortSrc = join(here, "..", "node_modules", "onnxruntime-web", "dist");

let count = 0;
const copiedExts = new Set();
for (const f of readdirSync(vadSrc).filter((n) => n.endsWith(".onnx") || n.endsWith(".js"))) {
  copyFileSync(join(vadSrc, f), join(targetDir, f));
  copiedExts.add(f.slice(f.lastIndexOf(".")));
  count++;
}
for (const f of readdirSync(ortSrc).filter((n) => n.endsWith(".wasm") || n.endsWith(".mjs"))) {
  copyFileSync(join(ortSrc, f), join(targetDir, f));
  copiedExts.add(f.slice(f.lastIndexOf(".")));
  count++;
}
// Guard against silent runtime breakage (FRE-1296): ort loads its .mjs loader
// before the .wasm, and vad-web needs the .onnx model. If an upstream package
// reshuffles its dist layout, fail the build here instead of shipping a /voice
// tab whose VAD dies silently behind the SPA fallback.
for (const required of [".mjs", ".wasm", ".onnx"]) {
  if (!copiedExts.has(required)) {
    throw new Error(`copy-vad-assets: no ${required} files found to copy - upstream dist layout changed; /voice VAD would break silently`);
  }
}
console.log(`copy-vad-assets: copied ${count} files into ${targetDir}`);
