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
 * （14日パージ対象）。②upload: 外部で用意した .safetensors——2026-09-19〜、
 * 生成ボタンを押す前に別途アップロードを完了させ、Volume相対パスとして
 * 渡す方式に変更（それまではfileを渡して生成開始時にアップロードして
 * いたが、1GB級のアップロード中にブラウザを閉じるとジョブ自体が一度も
 * 作られないまま止まってしまう問題があり、「アップロード」と「生成」を
 * 明確に別々の操作に分離した——ホスト指摘）。 */
export type DirectorLoraSelection =
  | { source: "none" }
  | { source: "trained"; loraId: string }
  | { source: "upload"; volumePath: string };

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
    loraUploadVolumePath = args.lora.volumePath;
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

/** アップロードの進捗を伝えるコールバック。loaded/total はファイル全体
 * バイト数基準（レジューム再開時も、既に届いている分を含めた値になる）。 */
export type DirectorLoraUploadProgress = (loaded: number, total: number) => void;

// 進捗イベントが一定時間発生しなければ「詰まった」とみなして中断する
// （2026-09-19導入）。実機で「69%・821.6MBで進捗が完全に止まり、エラーも
// 出ないまま固まる」事象を確認——タイムアウトを一切設定していなかった
// ため、接続が生きているのかどうかブラウザ側からは判別できず、
// XHRのonload/onerror/onabortのどれも発火しないまま無限に待ち続けて
// いた。stall検知でここを強制的に打ち切り、自動リトライへ渡す。
// データが流れている限り（遅くても）onprogressはこれよりずっと高頻度で
// 発火するので、短くしても遅い回線を誤検知することはない——再試行は
// 自動・安価なので、ホスト指摘どおり短めに倒す（45秒→10秒、2026-09-19）。
const STALL_TIMEOUT_MS = 10_000;

/** XMLHttpRequestでPOSTし、upload.onprogressで進捗を拾う（2026-09-19導入
 * ——1GB級のファイルをfetchで送りっぱなしにすると進捗が一切見えず
 * 「固まっているのか送信中なのか分からない」というホスト指摘への対応。
 * fetchのRequestStreamでも理論上は進捗を拾えるが、ブラウザ互換性が
 * XHRのupload.onprogressほど安定していないため採用しない）。 */
function xhrPostWithProgress(
  url: string,
  body: Blob,
  baseLoaded: number,
  total: number,
  onProgress?: DirectorLoraUploadProgress,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const armStallTimer = () => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        xhr.abort();
      }, STALL_TIMEOUT_MS);
    };

    xhr.upload.onprogress = (e) => {
      armStallTimer();
      if (onProgress) onProgress(baseLoaded + e.loaded, total);
    };
    xhr.onload = () => {
      clearStallTimer();
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // ignore — 呼び出し側が !uploadData?.path でエラーメッセージを出す
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json });
    };
    xhr.onerror = () => {
      clearStallTimer();
      reject(new Error("ネットワークエラーでアップロードに失敗しました。"));
    };
    xhr.onabort = () => {
      clearStallTimer();
      reject(new Error(`アップロードが${STALL_TIMEOUT_MS / 1000}秒間進まなかったため中断しました。もう一度同じファイルを選び直せば続きから再開できます。`));
    };
    armStallTimer(); // 最初の1バイトが届く前に詰まるケースもカバーする。
    xhr.send(body);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// スタール検知（10秒）で1回の試行が打ち切られても、ここまで自動で
// 再試行する（2026-09-19、ホスト指摘:「エラー表示するより再アップロード
// すれば良いのでは」——ユーザーの手を止めず、進捗バーだけ見せ続けて裏で
// 再試行する）。回数多めにしておいても、詰まっていない限り即座に成功
// するので実害はない。
const MAX_UPLOAD_ATTEMPTS = 30;
const RETRY_DELAY_MS = 1500;

/** 1回ぶんの試行: チケット発行→ステータス確認→（必要なら）アップロード。
 * チケットは試行ごとに毎回新規発行する——アップロードトークンの有効期限
 * (10分)より遅い回線で長時間かかると、使い回したチケットが期限切れに
 * なりうるため。 */
async function uploadDirectorLoraFileAttempt(
  file: File,
  filename: string,
  accessToken: string,
  onProgress?: DirectorLoraUploadProgress,
): Promise<string> {
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
    if (onProgress) onProgress(file.size, file.size);
    return ticket.volumePath as string;
  }
  if (onProgress) onProgress(existingBytes, file.size);

  const uploadUrl = buildSignedUrl(ticket.uploadUrl);
  if (existingBytes > 0) uploadUrl.searchParams.set("offset", String(existingBytes));
  const body = existingBytes > 0 ? file.slice(existingBytes) : file;

  const { ok: uploadOk, status: uploadStatus, json: uploadData } = await xhrPostWithProgress(
    uploadUrl.toString(),
    body,
    existingBytes,
    file.size,
    onProgress,
  );
  const uploadResult = uploadData as { path?: string; detail?: string; error?: string } | null;
  if (!uploadOk || !uploadResult?.path) {
    // detail/errorが無い（=サーバーがJSON以外を返した等）場合でもステータス
    // コードだけは表示する——次回の原因調査を「LoRAのアップロードに失敗
    // しました」だけより手掛かり付きにするため（2026-09-19、実機で
    // detail無し失敗を確認）。
    throw new Error(
      uploadResult?.detail || uploadResult?.error || `LoRAのアップロードに失敗しました（HTTP ${uploadStatus}）。`,
    );
  }
  return uploadResult.path;
}

export async function uploadDirectorLoraFile(
  userId: string,
  file: File,
  onProgress?: DirectorLoraUploadProgress,
): Promise<{ volumePath: string }> {
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
  // 1GB級のアップロード中に落ちても、ステータス確認で前回の続きを検出
  // して再開できる（ホスト指摘: 「仕掛けたらブラウザを落として良い」
  // という使い方が前提なら、単発送りっぱなしは脆すぎる）。
  const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "lora.safetensors";
  const filename = `${file.size}-${file.lastModified}-${safeName}`;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    try {
      const volumePath = await uploadDirectorLoraFileAttempt(file, filename, accessToken, onProgress);
      _uploadedLoraCache.set(file, volumePath);
      return { volumePath };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[directorApi] LoRA upload attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS} failed, retrying from where it left off:`,
        lastError.message,
      );
      if (attempt < MAX_UPLOAD_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError ?? new Error("LoRAのアップロードに失敗しました。");
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
