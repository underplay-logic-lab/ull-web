import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/adminApiGuard";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  listVolumeFiles,
  spawnDownloadToVolume,
  spawnRepoDownloadToVolume,
  deleteVolumeFile,
  deleteVolumeDir,
  MODEL_SUBFOLDERS,
} from "@/lib/modalStorage";

// Mirrors the Modal-side allowlist in scripts/modal_wan_animate.py
// (ALLOWED_DOWNLOAD_HOSTS) — checked here too as defense in depth before the
// request ever leaves our server.
const ALLOWED_DOWNLOAD_HOSTS = ["huggingface.co", "civitai.com"];

function isAllowedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_DOWNLOAD_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// Mirrors _is_valid_repo_id in scripts/modal_wan_animate.py — owner/name
// only (e.g. hotdogs/Qwen3.8-27B-Abliterated), no nested paths.
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isValidRepoId(repoId: string): boolean {
  return REPO_ID_RE.test(repoId) && !repoId.includes("..");
}

// Mirrors _sanitize_relative_dir in scripts/modal_wan_animate.py — the repo
// downloader isn't restricted to MODEL_SUBFOLDERS (a full repo like an LLM
// doesn't belong in one of ComfyUI's symlinked model-type folders), but the
// path still can't escape the volume.
function sanitizeSaveDir(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed.includes("\\")) return null;
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) return null;
  return segments.join("/");
}

export async function GET() {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  try {
    const files = await listVolumeFiles();
    return NextResponse.json({ files });
  } catch (err) {
    console.error("[admin/modal/storage] list failed:", err);
    return NextResponse.json({ error: "ファイル一覧の取得に失敗しました。" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "入力内容が不正です。" }, { status: 400 });
  }

  if (body.mode === "repo") {
    const repoId = typeof body.repo_id === "string" ? body.repo_id.trim() : "";
    const saveDir = typeof body.save_dir === "string" ? sanitizeSaveDir(body.save_dir) : null;

    if (!isValidRepoId(repoId)) {
      return NextResponse.json(
        { error: "リポジトリIDの形式が不正です（例: owner/repo-name）。" },
        { status: 400 },
      );
    }
    if (!saveDir) {
      return NextResponse.json({ error: "保存先ディレクトリが不正です。" }, { status: 400 });
    }

    // Same up-front 'pending' row pattern as the single-file path below —
    // url stores a browsable link to the repo since the table has no
    // separate repo_id column.
    const { data: downloadRow, error: insertError } = await supabaseAdmin
      .from("model_downloads")
      .insert({
        url: `https://huggingface.co/${repoId}`,
        save_path: saveDir,
        status: "pending",
        progress_percent: 0,
      })
      .select()
      .single();

    if (insertError) {
      console.error("[admin/modal/storage] failed to create model_downloads row (repo):", insertError.message);
      return NextResponse.json({ error: "ダウンロードタスクの作成に失敗しました。" }, { status: 500 });
    }

    try {
      await spawnRepoDownloadToVolume(downloadRow.id as string, repoId, saveDir);
      return NextResponse.json({ download: downloadRow }, { status: 202 });
    } catch (err) {
      console.error("[admin/modal/storage] failed to spawn repo download:", err);
      await supabaseAdmin
        .from("model_downloads")
        .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
        .eq("id", downloadRow.id);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "ダウンロードの開始に失敗しました。" },
        { status: 502 },
      );
    }
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const subfolder = typeof body.subfolder === "string" ? body.subfolder.trim() : "";
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";

  if (!url || !isAllowedHost(url)) {
    return NextResponse.json(
      { error: `URLは ${ALLOWED_DOWNLOAD_HOSTS.join(" / ")} のいずれかのみ許可されています。` },
      { status: 400 },
    );
  }
  if (!MODEL_SUBFOLDERS.includes(subfolder as (typeof MODEL_SUBFOLDERS)[number])) {
    return NextResponse.json(
      { error: `保存先は ${MODEL_SUBFOLDERS.join(" / ")} のいずれかを選択してください。` },
      { status: 400 },
    );
  }
  if (!filename || filename.includes("/") || filename.includes("..")) {
    return NextResponse.json({ error: "ファイル名が不正です。" }, { status: 400 });
  }

  const savePath = `${subfolder}/${filename}`;

  // Row created up front (status 'pending') so the admin's tasks panel has
  // something to show the instant this returns — the actual transfer runs
  // in the background via Modal's .spawn(), which updates this same row's
  // status/progress_percent as it streams (see download_model_async in
  // scripts/modal_wan_animate.py).
  const { data: downloadRow, error: insertError } = await supabaseAdmin
    .from("model_downloads")
    .insert({ url, save_path: savePath, status: "pending", progress_percent: 0 })
    .select()
    .single();

  if (insertError) {
    console.error("[admin/modal/storage] failed to create model_downloads row:", insertError.message);
    return NextResponse.json({ error: "ダウンロードタスクの作成に失敗しました。" }, { status: 500 });
  }

  try {
    await spawnDownloadToVolume(downloadRow.id as string, url, subfolder, filename);
    return NextResponse.json({ download: downloadRow }, { status: 202 });
  } catch (err) {
    console.error("[admin/modal/storage] failed to spawn download:", err);
    await supabaseAdmin
      .from("model_downloads")
      .update({ status: "failed", error_message: err instanceof Error ? err.message : String(err) })
      .eq("id", downloadRow.id);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ダウンロードの開始に失敗しました。" },
      { status: 502 },
    );
  }
}

export async function DELETE(request: Request) {
  const { user, response } = await requireAdmin();
  if (!user) return response;

  const body = await request.json().catch(() => null);
  const filePath = typeof body?.file_path === "string" ? body.file_path.trim() : "";
  const isDir = body?.is_dir === true;
  if (!filePath) {
    return NextResponse.json({ error: "file_path が指定されていません。" }, { status: 400 });
  }

  try {
    if (isDir) {
      await deleteVolumeDir(filePath);
    } else {
      await deleteVolumeFile(filePath);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[admin/modal/storage] delete failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "削除に失敗しました。" },
      { status: 502 },
    );
  }
}
