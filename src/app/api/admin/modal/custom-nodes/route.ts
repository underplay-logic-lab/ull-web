import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { installCustomNode } from "@/lib/modalStorage";

// Mirrors the Modal-side allowlist in scripts/modal_wan_animate.py
// (ALLOWED_GIT_HOSTS) — checked here too as defense in depth.
function isGithubUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "github.com" || host.endsWith(".github.com");
}

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  const gitUrl = typeof body?.git_url === "string" ? body.git_url.trim() : "";

  if (!gitUrl || !isGithubUrl(gitUrl)) {
    return NextResponse.json({ error: "GitHubのURLのみ許可されています（例: https://github.com/user/repo）。" }, { status: 400 });
  }

  try {
    const result = await installCustomNode(gitUrl);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("[admin/modal/custom-nodes] install failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "カスタムノードのインストールに失敗しました。" },
      { status: 502 },
    );
  }
}
