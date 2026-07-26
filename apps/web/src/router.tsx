import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

// TanStack Start はリクエストごとにルーターを生成する（SSR のため状態を共有しない）。
export function createRouter() {
  return createTanStackRouter({ routeTree, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
