import "server-only";

// ULL Cinematic Director のディスパッチ — modal_wan_animate_blackwell.py の
// custom_workflow_async（プレーンな @app.function、GPU-less な即時 ACK
// エンドポイント。実処理は .spawn() で別途 GPU コンテナに投げる）を叩く。
// 旧 Cinematic Video タブの modalCinematic.ts は 2026-09-09 に削除済み
// （[[cinematic-video-tab]]）なので、同じ構造で新規に用意する。
//
// 必要な env（Vercel）: MODAL_DIRECTOR_URL（例:
// https://axelbh5--ull-wan-animate-blackwell-custom-workflow-async.modal.run）、
// MODAL_AUTH_TOKEN（wan-animate-auth シークレットと同じ値）。

export type SpawnDirectorJobParams = {
  jobId: string;
  userId: string;
  creditsCost: number;
  workflow: Record<string, unknown>;
  referenceImageName: string;
  referenceImageB64: string;
  pollDeadlineS: number;
};

export async function spawnDirectorJob(params: SpawnDirectorJobParams): Promise<{ callId: string | null }> {
  const url = process.env.MODAL_DIRECTOR_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!url) {
    throw new Error("MODAL_DIRECTOR_URL が未設定です（modal_wan_animate_blackwell.py の custom_workflow_async のURL）。");
  }
  if (!authToken) {
    throw new Error("MODAL_AUTH_TOKEN が未設定です。");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-modal-secret": authToken,
    },
    body: JSON.stringify({
      job_id: params.jobId,
      user_id: params.userId,
      credits_cost: params.creditsCost,
      workflow_json: JSON.stringify(params.workflow),
      files_b64: { [params.referenceImageName]: params.referenceImageB64 },
      skip_torch_compile: true,
      poll_deadline_s: params.pollDeadlineS,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal dispatch failed (${res.status}): ${text.slice(0, 2000)}`);
  }
  const data = (await res.json()) as { ok: boolean; job_id: string; call_id?: string };
  return { callId: data.call_id ?? null };
}
