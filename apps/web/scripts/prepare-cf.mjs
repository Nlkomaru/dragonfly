import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(webDir, ".cloudflare/output/v0");
const workerDir = path.join(outputDir, "workers/default");
const bundleDir = path.join(workerDir, "bundle");
const assetsDir = path.join(workerDir, "assets");
const serverDistDir = path.join(webDir, "dist/server");
const clientDistDir = path.join(webDir, "dist/client");

fs.rmSync(path.join(webDir, ".cloudflare/output"), { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });

fs.cpSync(serverDistDir, bundleDir, { recursive: true, dereference: true });
fs.cpSync(clientDistDir, assetsDir, { recursive: true, dereference: true });

function collectModules(dir, prefix = "") {
  const modules = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(modules, collectModules(full, rel));
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
      modules[rel] = { type: "esm" };
    } else if (entry.name.endsWith(".wasm")) {
      modules[rel] = { type: "wasm" };
    } else if (entry.name.endsWith(".json") || entry.name.endsWith(".txt")) {
      modules[rel] = { type: "text" };
    } else {
      modules[rel] = { type: "data" };
    }
  }
  return modules;
}

fs.writeFileSync(
  path.join(outputDir, "config.json"),
  JSON.stringify({ buildContext: { isPreview: false } }),
);

fs.writeFileSync(
  path.join(workerDir, "worker.config.json"),
  JSON.stringify({
    name: "dragonfly-web",
    compatibilityDate: "2025-07-01",
    compatibilityFlags: ["nodejs_compat"],
    domains: ["dragonfly.vrc.nikomaru.dev"],
    env: {
      PHOTOS: { type: "r2", name: "dragonfly-photos" },
      DB: { type: "d1", id: "6d3b4492-c258-4ade-b97d-50d73563ed5a", name: "dragonfly" },
    },
    observability: {
      enabled: true,
      headSamplingRate: 1,
    },
    manifest: {
      type: "complete",
      mainModule: "server.js",
      modules: collectModules(bundleDir),
    },
  }),
);
