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
  /**
   * Advanced モード（Qwen3.8-27B-abliteratedによる台本自動生成、
   * 2026-09-18追加）用。3つ揃って渡されると、動画生成と同じB300コンテナ内
   * （ComfyUI実行の直前）でこのVLMが参照画像＋思いつきから台本を書き起こし、
   * workflow[qwenPromptNodeId].inputs.prompt を上書きしてから実行する
   * （別GPUを新たに起動しないための設計 — 2つ目のコールドスタートを避ける）。
   */
  qwenConceptText?: string;
  qwenPromptNodeId?: string;
  qwenDurationS?: number;
  /** generation_jobs.inputs の元スナップショット（Advancedモードでワーカー側が
   * combined_prompt を書き戻す際、他フィールドを消さずマージするために必要 —
   * PATCHはJSONBカラム丸ごと置き換えのため）。 */
  directorInputsSnapshot?: Record<string, unknown>;
  /** 外部アップロードLoRA（2026-09-18導入・同日中に設計変更）用のVolume
   * 相対パス（modal_lora_worker.py::upload_user_lora が保存した先、
   * "director_user_loras/<user_id>/<file>"）。渡されると、ワーカーが
   * ComfyUI実行前にこのVolume上のファイルをローカルコピーで
   * COMFY_DIR/models/loras/ へ配置する（Supabase Storageを経由しないので
   * ネットワーク転送が発生しない）。loraFilename（workflow 側の lora_name
   * と同じ値）とセットで渡す。 */
  loraVolumePath?: string;
  loraFilename?: string;
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
      qwen_concept_text: params.qwenConceptText,
      qwen_prompt_node_id: params.qwenPromptNodeId,
      qwen_duration_s: params.qwenDurationS,
      director_inputs_snapshot: params.directorInputsSnapshot,
      lora_volume_path: params.loraVolumePath,
      lora_filename: params.loraFilename,
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
