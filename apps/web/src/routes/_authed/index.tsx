import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/")({
  component: Index,
});

function Index() {
  return <main className="p-8">dragonfly web</main>;
}
