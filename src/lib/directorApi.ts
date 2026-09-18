import { supabase } from "@/lib/supabaseClient";
import { uploadStudioAsset } from "@/lib/studioUploads";
import type { DirectorQualityMode, DirectorScene } from "@/lib/directorPricing";

export type DirectorApiError = Error & { remainingCredits?: number };

export type DirectorStartResult = {
  jobId: string;
  creditsCost: number;
  remainingCredits: number;
  totalDurationS: number;
};

export type DirectorStartArgs = (
  | {
      userId: string;
      image: File;
      scenes: DirectorScene[];
      rawPrompt?: undefined;
      conceptText?: undefined;
      /** 動画全体の音楽・環境音の指示（任意、シーンビルダー限定・2026-09-15追加）。 */
      musicDirection?: string;
    }
  | {
      userId: string;
      image: File;
      rawPrompt: string;
      rawDurationS: number;
      scenes?: undefined;
      conceptText?: undefined;
      musicDirection?: undefined;
    }
  | {
      // Advanced モード（2026-09-18追加）: 短い日本語の思いつきを渡すと、
      // Qwen（自己ホストVLM）が参照画像を見て台本を書き起こす。
      userId: string;
      image: File;
      conceptText: string;
      rawDurationS: number;
      scenes?: undefined;
      rawPrompt?: undefined;
      musicDirection?: undefined;
    }
) & {
  quality: DirectorQualityMode;
  /** true: 実行中のジョブを待たず並列で今すぐ実行（追加料金）。既定 false = 順番待ち。 */
  priority?: boolean;
  /** LoRA選択（全モード共通、2026-09-18追加）。省略/"none" はLoRAなし。 */
  lora?: DirectorLoraSelection;
};

/** LoRAの指定方法。①trained: LoRA Studioで本人が学習済みのMiniMax H3 LoRA
 * （14日パージ対象）。②upload: 外部で用意した .safetensors をこの場で
 * アップロード（生成物ではなく入力データ扱いのため期限なし）。 */
export type DirectorLoraSelection =
  | { source: "none" }
  | { source: "trained"; loraId: string }
  | { source: "upload"; file: File };

export async function startDirectorJob(args: DirectorStartArgs): Promise<DirectorStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const { path: storagePath } = await uploadStudioAsset(args.userId, args.image);

  let loraId: string | undefined;
  let loraUploadVolumePath: string | undefined;
  if (args.lora?.source === "trained") {
    loraId = args.lora.loraId;
  } else if (args.lora?.source === "upload") {
    const uploaded = await uploadDirectorLoraFile(args.userId, args.lora.file);
    loraUploadVolumePath = uploaded.volumePath;
  }

  const priority = args.priority ?? false;
  const loraFields = { loraId, loraUploadVolumePath };
  const body =
    "conceptText" in args && args.conceptText !== undefined
      ? {
          storagePath,
          conceptText: args.conceptText,
          rawDurationS: args.rawDurationS,
          quality: args.quality,
          priority,
          ...loraFields,
        }
      : "rawPrompt" in args && args.rawPrompt !== undefined
        ? {
            storagePath,
            rawPrompt: args.rawPrompt,
            rawDurationS: args.rawDurationS,
            quality: args.quality,
            priority,
            ...loraFields,
          }
        : {
            storagePath,
            scenes: args.scenes,
            musicDirection: args.musicDirection,
            quality: args.quality,
            priority,
            ...loraFields,
          };

  const res = await fetch("/api/director/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const error: DirectorApiError = new Error(data?.error || "動画生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    throw error;
  }
  return {
    jobId: data.jobId as string,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    totalDurationS: data.totalDurationS as number,
  };
}

// 外部LoRA（.safetensors）アップロード（2026-09-18導入・同日中に設計変更）。
// 当初 Supabase Storage 経由だったが、Freeプランのグローバルアップロード
// 上限（プロジェクト全体で50MB固定、バケット単位のfile_size_limitとは別物で
// 引き上げ不可）に阻まれ、実運用サイズのLoRA（rank32のminimax_h3で約1.18GB）
// を通せないことが実機で判明したため撤回。modal_lora_worker.py::
// upload_user_lora へブラウザから直接アップロードする（Vercel/Supabase
// どちらのボディサイズ上限も経由せず、Supabaseの月間転送量クォータにも
// 一切カウントされない）。
const DIRECTOR_LORA_MAX_BYTES = 2 * 1024 * 1024 * 1024; // Modal側エンドポイントの上限（2GB）と合わせる

// 同じFileオブジェクト（＝ユーザーがファイル選択を変えない限り、連続生成の
// たびに呼ばれるuploadDirectorLoraFileへ渡される参照は同一）を毎回フルサイズ
// （rank32のminimax_h3で約1.18GB）再アップロードしていた無駄を防ぐ
// （2026-09-19、ホスト指摘）。Volume側は「入力データなので保持期限なし」
// という当初の整理だったが、再アップロードのたびに新規UUIDファイル名で
// 重複が無期限に積み上がる欠陥も併発していたため、こちらの重複自体を
// 防ぐのが本筋の対策——保持期限の見直しは modal_retention_purge.py 側で
// 別途対応（director_user_loras/を14日パージ対象に追加）。
// WeakMapなのでFileオブジェクトがGCされれば（＝ユーザーが別ファイルを
// 選び直せば）自動的にエントリも消える。
const _uploadedLoraCache = new WeakMap<File, string>();

export async function uploadDirectorLoraFile(userId: string, file: File): Promise<{ volumePath: string }> {
  const cached = _uploadedLoraCache.get(file);
  if (cached) return { volumePath: cached };

  if (!file.name.toLowerCase().endsWith(".safetensors")) {
    throw new Error(".safetensors ファイルを選んでください。");
  }
  if (file.size > DIRECTOR_LORA_MAX_BYTES) {
    throw new Error("ファイルサイズが大きすぎます（上限2GB）。");
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  // ファイルサイズ＋更新日時から決定的な名前を作る（2026-09-19、乱数UUID
  // から変更）。同じファイルを選び直せば毎回同じVolumeパスに解決するので、
  // ブラウザがバックグラウンドタブの切断・スリープ・ネットワーク断で
  // 1GB級のアップロード中に落ちても、下のステータス確認で前回の続きを
  // 検出して再開できる（ホスト指摘: 「仕掛けたらブラウザを落として良い」
  // という使い方が前提なら、単発送りっぱなしは脆すぎる）。
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "lora.safetensors";
  const filename = `${file.size}-${file.lastModified}-${safeName}`;

  const ticketRes = await fetch("/api/director/loras/upload-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ filename }),
  });
  const ticket = await ticketRes.json();
  if (!ticketRes.ok) throw new Error(ticket?.error || "アップロード準備に失敗しました。");

  const buildSignedUrl = (base: string): URL => {
    const u = new URL(base);
    u.searchParams.set("user_id", ticket.userId);
    u.searchParams.set("filename", ticket.filename);
    u.searchParams.set("expires", String(ticket.expiresAt));
    u.searchParams.set("sig", ticket.sig);
    return u;
  };

  // 前回どこまで届いているか確認する（失敗しても致命的ではない——確認
  // できなければ existingBytes=0 のまま、つまり最初から送るだけ）。
  let existingBytes = 0;
  try {
    const statusRes = await fetch(buildSignedUrl(ticket.statusUrl).toString());
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (typeof statusData?.size_bytes === "number") existingBytes = statusData.size_bytes;
    }
  } catch (err) {
    console.warn("[directorApi] upload status check failed, uploading from scratch:", err);
  }

  if (existingBytes >= file.size) {
    // 既に前回のアップロードで最後まで届いていた（レスポンスが返る前に
    // 切断されただけ等）。
    _uploadedLoraCache.set(file, ticket.volumePath as string);
    return { volumePath: ticket.volumePath as string };
  }

  const uploadUrl = buildSignedUrl(ticket.uploadUrl);
  if (existingBytes > 0) uploadUrl.searchParams.set("offset", String(existingBytes));
  const body = existingBytes > 0 ? file.slice(existingBytes) : file;

  const uploadRes = await fetch(uploadUrl.toString(), {
    method: "POST",
    body,
    headers: { "Content-Type": "application/octet-stream" },
  });
  const uploadData = await uploadRes.json().catch(() => null);
  if (!uploadRes.ok || !uploadData?.path) {
    throw new Error(uploadData?.detail || uploadData?.error || "LoRAのアップロードに失敗しました。");
  }
  const volumePath = uploadData.path as string;
  _uploadedLoraCache.set(file, volumePath);
  return { volumePath };
}

export type DirectorLoraOption = { id: string; label: string };

/** 現在のユーザーが LoRA Studio で学習済みの MiniMax H3 LoRA 一覧
 * （2026-09-18追加、LoRA選択ピッカー用）。 */
export async function listDirectorLoras(): Promise<DirectorLoraOption[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return [];

  const res = await fetch("/api/director/loras", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data?.loras) ? (data.loras as DirectorLoraOption[]) : [];
}

/** 公開 URL を実ファイルとして保存させる（cross-origin download 対策）。
 * 2026-09-17: videoUrl が旧 data: URI から director-results バケットの公開
 * URL へ移行したため、plain `<a download>` はクロスオリジンで無視される
 * ブラウザがあり得る（downloadUpscaleImage と同じ fetch→blob 方式に統一）。 */
export async function downloadDirectorVideo(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`動画の取得に失敗しました (${res.status})`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export type DirectorJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
  vramUsedGb: number | null;
  combinedPrompt: string | null;
  combinedPromptJa: string | null;
  totalDurationS: number | null;
  queue: { queuePosition: number; avgExecutionSeconds: number; estimatedWaitSeconds: number } | null;
};

export async function pollDirectorJob(jobId: string): Promise<DirectorJobStatus> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch(`/api/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");

  const meta = (data.metadata ?? {}) as { vram_used_gb?: unknown; total_duration_s?: unknown };
  const vramUsedGb =
    typeof meta.vram_used_gb === "number" && Number.isFinite(meta.vram_used_gb) ? meta.vram_used_gb : null;

  return {
    jobId: data.jobId as string,
    status: data.status as DirectorJobStatus["status"],
    videoUrl: (data.videoUrl as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    vramUsedGb,
    combinedPrompt: (data.combinedPrompt as string | null) ?? null,
    combinedPromptJa: (data.combinedPromptJa as string | null) ?? null,
    totalDurationS: typeof meta.total_duration_s === "number" ? meta.total_duration_s : null,
    queue:
      typeof data.queuePosition === "number"
        ? {
            queuePosition: data.queuePosition as number,
            avgExecutionSeconds: (data.avgExecutionSeconds as number | undefined) ?? 28,
            estimatedWaitSeconds: (data.estimatedWaitSeconds as number | undefined) ?? 0,
          }
        : null,
  };
}
