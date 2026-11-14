import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "dragonfly-web",
    entrypoint: "@tanstack/react-start/server-entry",
    compatibilityDate: "2025-07-01",
    compatibilityFlags: ["nodejs_compat"],
    domains: ["dragonfly.vrc.nikomaru.dev"],
    observability: {
      enabled: true,
      headSamplingRate: 1,
    },
    env: {
      PHOTOS: bindings.r2({ name: "dragonfly-photos" }),
      DB: bindings.d1({ id: "6d3b4492-c258-4ade-b97d-50d73563ed5a", name: "dragonfly" }),
    },
  },
});
