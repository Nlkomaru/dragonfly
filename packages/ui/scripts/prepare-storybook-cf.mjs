import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(uiDir, ".cloudflare/output/v0");
const workerDir = path.join(outputDir, "workers/default");

fs.rmSync(path.join(uiDir, ".cloudflare/output"), { recursive: true, force: true });
fs.mkdirSync(workerDir, { recursive: true });

fs.writeFileSync(
  path.join(outputDir, "config.json"),
  JSON.stringify({ buildContext: { isPreview: false } }),
);

fs.writeFileSync(
  path.join(workerDir, "worker.config.json"),
  JSON.stringify({
    name: "dragonfly-sb",
    compatibilityDate: "2025-07-01",
    assets: {},
    domains: ["dragonfly-sb.vrc.nikomaru.dev"],
  }),
);

fs.cpSync(path.join(uiDir, "storybook-static"), path.join(workerDir, "assets"), {
  recursive: true,
  dereference: true,
});
