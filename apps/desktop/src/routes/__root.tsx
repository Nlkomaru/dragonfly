import { Outlet, createRootRoute } from "@tanstack/react-router";
import { UpdateNotifier } from "../components/UpdateNotifier";

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-background text-foreground">
      {/* 起動時に自動更新をチェックする。デスクトップ固有なので root に置く。 */}
      <UpdateNotifier />
      <Outlet />
    </div>
  ),
});
