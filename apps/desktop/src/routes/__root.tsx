import { Link, Outlet, createRootRoute, useNavigate } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Settings } from "lucide-react";
import { MonthSidebar } from "@dragonfly/ui";
import { UpdateNotifier } from "../components/UpdateNotifier";
import { useInitialPhotoScan } from "../hooks/usePhotoLibrary";
import { activeMonthAtom, monthBucketsAtom, selectedMonthAtom } from "../state/photos";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  // サイドバーは全画面共通なので、初回走査もここで1回だけ行う。
  useInitialPhotoScan();

  // atom は Provider 無しの既定ストアを使うため、root で読んでも各画面と同じ値になる。
  const buckets = useAtomValue(monthBucketsAtom);
  const activeMonth = useAtomValue(activeMonthAtom);
  const setSelectedMonth = useSetAtom(selectedMonthAtom);
  const navigate = useNavigate();

  return (
    // PhotoGrid が自身の高さを測るため、root から高さを固定して min-h-0 を繋ぐ。
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* 起動時に自動更新をチェックする。デスクトップ固有なので root に置く。 */}
      <UpdateNotifier />

      {/* 左サイドバー: VRChat が月フォルダで保存するので、月が一覧の単位になる。 */}
      <MonthSidebar
        buckets={buckets}
        activeMonth={activeMonth}
        // 設定画面から月を選んだ場合はサイドバーが効かないように見えるので、一覧へ戻す。
        onSelectMonth={(month) => {
          setSelectedMonth(month);
          void navigate({ to: "/" });
        }}
        footer={
          <Link
            to="/settings"
            className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
            // MonthSidebar 本体は共有コンポーネントなので、現在地の強調はここで完結させる。
            // Link は className を単純連結するだけなので、色は active/inactive で分けて衝突を避ける。
            activeProps={{ className: "bg-accent font-medium text-accent-foreground" }}
            inactiveProps={{ className: "text-muted-foreground" }}
          >
            <Settings className="size-4" />
            設定
          </Link>
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
