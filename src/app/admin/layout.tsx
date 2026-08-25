import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ShieldCheck, Wrench } from "lucide-react";
import { getAdminUser } from "@/lib/adminAuth";

// Persistent (modal deploy, not ephemeral serve) URL for the T4 ComfyUI dev
// GUI — see modal_comfyui_dev.py at the repo root. Hardcoded rather than an
// env var: it's a fixed dev-tool endpoint, not a secret, and only ever
// changes if that app is redeployed under a different name.
const COMFYUI_DEV_URL = "https://axelbh5--ull-comfyui-dev-comfyui-server.modal.run";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getAdminUser();

  // No public /studio route exists — Studio is the #studio section on the
  // homepage (see src/app/page.tsx) — so unauthorized visitors land there.
  if (!user) {
    redirect("/#studio");
  }

  return (
    <div className="relative min-h-screen bg-background pt-16 text-foreground">
      <div className="pointer-events-none fixed inset-0 grid-bg opacity-30" />

      <header className="sticky top-16 z-40 border-b border-border bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="text-neon-pink" size={20} />
            <span className="font-mono text-sm font-bold tracking-tight sm:text-base">
              ULL Studio <span className="text-gradient">Admin Dashboard</span>
            </span>
          </div>

          <div className="flex items-center gap-4">
            <span className="hidden max-w-[14rem] truncate text-xs text-muted sm:inline">
              {user.email}
            </span>
            <a
              href={COMFYUI_DEV_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="アクセス時にT4 GPUが自動起動します（放置時は自動スリープし、その間の課金はありません）"
              className="flex items-center gap-1.5 rounded-full border border-neon-violet/50 bg-neon-violet/15 px-3 py-1.5 text-xs font-medium text-neon-violet transition-colors hover:bg-neon-violet/25"
            >
              <Wrench size={14} />
              🛠️ クラウドComfyUIを開く
            </a>
            <Link
              href="/#studio"
              className="flex items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1.5 text-xs text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
            >
              <ArrowLeft size={14} />
              スタジオへ戻る
            </Link>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
