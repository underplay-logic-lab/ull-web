import { supabase } from "@/lib/supabaseClient";
import { uploadStudioAsset } from "@/lib/studioUploads";
import {
  DIRECTOR_ASPECTS,
  isDirectorQualityMode,
  type DirectorAspectId,
  type DirectorQualityMode,
  type DirectorReferenceMode,
  type DirectorRefRole,
  type DirectorRefVideoRole,
  type DirectorScene,
} from "@/lib/directorPricing";

/**
 * code "restricted"（2026-10-06）: 表現の制限がある AI に断られた（課金前）。画面は「制限を解除しますか？（+unrestrictedSurcharge C）」を出し、
 * 同じ内容を scriptEngine: "unrestricted" で送り直す。
 */
export type DirectorApiError = Error & { remainingCredits?: number; code?: "restricted"; unrestrictedSurcharge?: number };

/** 台本・英訳・写真の指示文を書く AI。unrestricted = 制限なし（追加料金）。 */
export type DirectorScriptEngine = "standard" | "unrestricted";

export type DirectorStartResult = {
  jobId: string;
  /** 予約として受け付けた（まだ始まっていない）。queue: true で、前のジョブが動いているとき。 */
  reserved: boolean;
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
  /** true: 予約（順番待ち）。その場で課金し、前のジョブが終わったらサーバーが起動する（タブを閉じても進む）。 */
  queue?: boolean;
  /** LoRA選択（全モード共通、2026-09-18追加）。省略/"none" はLoRAなし。 */
  lora?: DirectorLoraSelection;
} & DirectorMediaOptions;

/** 全モード共通の素材の指定（2026-10-05）。 */
export type DirectorMediaOptions = {
  /** 持ち込み音声（歌・セリフ）。尺は durationS（画面が測った長さ）になる。 */
  audio?: { file: File; durationS: number } | null;
  /** 画像の使い方。既定 first_frame（最初のフレーム）。reference は顔写真として参照。 */
  referenceMode?: DirectorReferenceMode;
  /** 参照モードの縦横。 */
  aspect?: DirectorAspectId;
  /** 参照モードで足す写真（2 枚目以降・最大 8 枚）。 */
  extraRefs?: File[];
  /** 足した写真それぞれの使い方（extraRefs と同じ順、2026-10-06）。省略は「同じ人物」。 */
  extraRefRoles?: DirectorRefRole[];
  /** 手本の動画（動き／カメラ、2〜15 秒）。durationS は画面が測った長さ。参照モードだけ。 */
  refVideo?: { file: File; durationS: number; role: DirectorRefVideoRole } | null;
  /** 声の手本（数秒）。参照モードで、歌・セリフを持ち込まないときだけ。 */
  refVoice?: File | null;
  /** 制限なしモード（2026-10-06）。 */
  scriptEngine?: DirectorScriptEngine;
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
  | { source: "trained"; loraId: string; triggerWord?: string }
  | { source: "upload"; r2Key: string; triggerWord?: string };

/** 出力の縦横比（幅÷高さ）。「画像に合わせる」は参照画像の比。読めなければ 0（切り抜かない）。 */
async function outputAspectRatio(aspect: DirectorAspectId, image: File): Promise<number> {
  const a = DIRECTOR_ASPECTS.find((x) => x.id === aspect);
  if (a && a.ratio > 0) return a.ratio;
  try {
    const bmp = await createImageBitmap(image);
    const r = bmp.width / bmp.height;
    bmp.close?.();
    return r;
  } catch {
    return 0;
  }
}

/** 画像を指定の縦横比で中央から切り抜いた PNG にする。すでにほぼ同じ比・読めないときは元のまま。 */
async function cropToAspect(file: File, ratio: number): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const r = bmp.width / bmp.height;
    if (Math.abs(r - ratio) / ratio < 0.02) {
      bmp.close?.();
      return file;
    }
    const w = r > ratio ? Math.round(bmp.height * ratio) : bmp.width;
    const h = r > ratio ? bmp.height : Math.round(bmp.width / ratio);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(bmp, (bmp.width - w) / 2, (bmp.height - h) / 2, w, h, 0, 0, w, h);
    bmp.close?.();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "")}_crop.png`, { type: "image/png" });
  } catch {
    return file;
  }
}

export async function startDirectorJob(args: DirectorStartArgs): Promise<DirectorStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const { path: storagePath } = await uploadStudioAsset(args.userId, args.image);
  // 「場所」の写真は出力の縦横に合わせて中央を切り抜く（2026-10-06）。縦長の場所の写真を横長の動画に使うと、
  // 写真の幅のまま左右に黒帯が出た（B300 実測・1376 幅の中央 1,105px）。
  const placeRatio =
    args.referenceMode === "reference" && args.extraRefRoles?.includes("place")
      ? await outputAspectRatio(args.aspect ?? "image", args.image)
      : 0;
  const extraRefPaths =
    args.referenceMode === "reference" && args.extraRefs?.length
      ? await Promise.all(
          args.extraRefs.slice(0, 8).map(async (f, i) => {
            const file = placeRatio && args.extraRefRoles?.[i] === "place" ? await cropToAspect(f, placeRatio) : f;
            return (await uploadStudioAsset(args.userId, file)).path;
          }),
        )
      : undefined;
  const refMode = args.referenceMode === "reference";
  const refVideoFields =
    refMode && args.refVideo
      ? {
          refVideoPath: (await uploadStudioAsset(args.userId, args.refVideo.file)).path,
          refVideoRole: args.refVideo.role,
          refVideoDurationS: args.refVideo.durationS,
        }
      : {};
  const refVoiceFields =
    refMode && args.refVoice && !args.audio
      ? { refVoicePath: (await uploadStudioAsset(args.userId, args.refVoice)).path }
      : {};
  const audioFields = args.audio
    ? {
        audioStoragePath: (await uploadStudioAsset(args.userId, args.audio.file)).path,
        audioDurationS: args.audio.durationS,
      }
    : {};

  let loraId: string | undefined;
  let loraUploadR2Key: string | undefined;
  if (args.lora?.source === "trained") {
    loraId = args.lora.loraId;
  } else if (args.lora?.source === "upload") {
    loraUploadR2Key = args.lora.r2Key;
  }

  const priority = args.priority ?? false;
  // トリガーワード（2026-10-04）: サーバー／ワーカーが最終の指示文に入っていなければ先頭に足す。
  const loraTriggerWord = args.lora && args.lora.source !== "none" ? args.lora.triggerWord : undefined;
  const loraFields = {
    loraId,
    loraUploadR2Key,
    loraTriggerWord,
    ...(args.queue ? { queue: true } : {}),
    ...audioFields,
    referenceMode: args.referenceMode,
    aspect: args.aspect,
    ...(extraRefPaths ? { extraRefPaths, extraRefRoles: args.extraRefRoles?.slice(0, 8) } : {}),
    ...refVideoFields,
    ...refVoiceFields,
    ...(args.scriptEngine === "unrestricted" ? { scriptEngine: "unrestricted" } : {}),
  };
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
    if (data?.code === "restricted") {
      error.code = "restricted";
      error.unrestrictedSurcharge = typeof data.unrestrictedSurcharge === "number" ? data.unrestrictedSurcharge : 0;
    }
    throw error;
  }
  return {
    jobId: data.jobId as string,
    reserved: data.reserved === true,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    totalDurationS: data.totalDurationS as number,
  };
}

/**
 * Photo Director（2026-10-06）: 参照写真から静止画を 1〜4 枚。サーバーは Director と同じ route（output: "photo"）で、
 * ジョブも Director と同じ予約の順番に並ぶ。場所の写真は動画と同じく出力の縦横に切り抜いてから上げる。
 */
export async function startPhotoJob(args: {
  userId: string;
  image: File;
  idea: string;
  /** 前のプロンプトを編集して作るとき（日本語でも可・サーバーが英訳）。あれば idea より優先。 */
  prompt?: string;
  count: number;
  aspect: DirectorAspectId;
  extraRefs: File[];
  extraRefRoles: DirectorRefRole[];
  priority?: boolean;
  queue?: boolean;
  scriptEngine?: DirectorScriptEngine;
}): Promise<DirectorStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const { path: storagePath } = await uploadStudioAsset(args.userId, args.image);
  const placeRatio = args.extraRefRoles.includes("place") ? await outputAspectRatio(args.aspect, args.image) : 0;
  const extraRefPaths = await Promise.all(
    args.extraRefs.slice(0, 8).map(async (f, i) => {
      const file = placeRatio && args.extraRefRoles[i] === "place" ? await cropToAspect(f, placeRatio) : f;
      return (await uploadStudioAsset(args.userId, file)).path;
    }),
  );
  const res = await fetch("/api/director/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      output: "photo",
      storagePath,
      photoIdea: args.idea,
      ...(args.prompt ? { photoPrompt: args.prompt } : {}),
      photoCount: args.count,
      aspect: args.aspect,
      extraRefPaths,
      extraRefRoles: args.extraRefRoles.slice(0, 8),
      priority: args.priority ?? false,
      ...(args.queue ? { queue: true } : {}),
      ...(args.scriptEngine === "unrestricted" ? { scriptEngine: "unrestricted" } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const error: DirectorApiError = new Error(data?.error || "写真の生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    if (data?.code === "restricted") {
      error.code = "restricted";
      error.unrestrictedSurcharge = typeof data.unrestrictedSurcharge === "number" ? data.unrestrictedSurcharge : 0;
    }
    throw error;
  }
  return {
    jobId: data.jobId as string,
    reserved: data.reserved === true,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    totalDurationS: 0,
  };
}

/**
 * 完了した動画を元に作り直す（2026-10-01〜）。参照画像・台本・尺・LoRA はサーバーが元のジョブから引き継ぐ。
 *   new_seed  … 別パターン（台本はそのまま、揺れだけ変える）
 *   same_seed … この動画をもとに調整（同じシードで、rawPrompt を書き換えたり画質を変えたりする）
 */
export async function regenerateDirectorJob(args: {
  baseJobId: string;
  variation: "new_seed" | "same_seed";
  rawPrompt?: string;
  rawDurationS?: number;
  quality?: DirectorQualityMode;
  priority?: boolean;
  queue?: boolean;
  /** 今アップロードした持ち込み LoRA（元のジョブの分は使い終わって消えている）。 */
  lora?: DirectorLoraSelection;
  scriptEngine?: DirectorScriptEngine;
}): Promise<DirectorStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");
  const { lora, ...rest } = args;
  const res = await fetch("/api/director/generate", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...rest,
      priority: args.priority ?? false,
      ...(lora?.source === "upload" ? { loraUploadR2Key: lora.r2Key, loraTriggerWord: lora.triggerWord } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const error: DirectorApiError = new Error(data?.error || "動画生成に失敗しました。");
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    if (data?.code === "restricted") {
      error.code = "restricted";
      error.unrestrictedSurcharge = typeof data.unrestrictedSurcharge === "number" ? data.unrestrictedSurcharge : 0;
    }
    throw error;
  }
  return {
    jobId: data.jobId as string,
    reserved: data.reserved === true,
    creditsCost: data.creditsCost as number,
    remainingCredits: data.remainingCredits as number,
    totalDurationS: data.totalDurationS as number,
  };
}

// 外部LoRA（.safetensors）アップロード。
// 2026-09-18〜10-03 はブラウザ → Modal（modal_lora_worker.py::upload_user_lora）→ Volume の 1 本の接続で送っていたが、
// 日米往復のせいで 1 本あたり約 2.2 Mbps で頭打ちになり（docs/gpu-benchmarks.md §15）、1GB 級に数十分かかった。
// 2026-10-03 から R2 へ 32MB ずつ並行に PUT する（S3 マルチパート、/api/director/loras/r2-upload）。
// 保存期間（2026-10-04 ホスト判断）: このタブを開いている間は使い回し（連続生成のたびに上げ直さない）、タブを閉じたら
// 削除を頼む（pagehide → sendBeacon → /api/director/loras/release）。届かなかった分は R2 が 1 日後に消す。
const DIRECTOR_LORA_MAX_BYTES = 2 * 1024 * 1024 * 1024; // サーバー側の上限（2GB）と合わせる

// 同じ File を連続生成のたびに上げ直さない（ファイルを選び直せば WeakMap から自然に消える）。
const _uploadedLoraCache = new WeakMap<File, string>();

/** 1 日たって消えていた等で「もう一度アップロード」になったとき、使い回しをやめる。 */
export function forgetUploadedDirectorLora(file: File): void {
  _uploadedLoraCache.delete(file);
}

// このタブで上げた LoRA（キー → 削除依頼の署名）。タブを閉じるときにまとめて削除を頼む。
const _uploadedThisTab = new Map<string, string>();
let _releaseHooked = false;

function hookReleaseOnClose(): void {
  if (_releaseHooked || typeof window === "undefined") return;
  _releaseHooked = true;
  window.addEventListener("pagehide", () => {
    for (const [key, sig] of _uploadedThisTab) {
      try {
        navigator.sendBeacon(
          "/api/director/loras/release",
          new Blob([JSON.stringify({ key, sig })], { type: "application/json" }),
        );
      } catch {
        // 届かなくても R2 が 1 日後に消す。
      }
    }
  });
}

/** アップロードの進捗。loaded/total はファイル全体のバイト数。 */
export type DirectorLoraUploadProgress = (loaded: number, total: number) => void;

const PART_CONCURRENCY = 6;
const PART_ATTEMPTS = 4;
// 進捗が止まったら打ち切って、その部分だけ送り直す（2026-09-19 に「69% で固まりエラーも出ない」を踏んだ）。
const STALL_TIMEOUT_MS = 30_000;

function putPart(
  url: string,
  body: Blob,
  onLoaded: (loaded: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    let stall: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (stall) clearTimeout(stall);
      stall = setTimeout(() => xhr.abort(), STALL_TIMEOUT_MS);
    };
    const done = () => {
      if (stall) clearTimeout(stall);
    };
    xhr.upload.onprogress = (e) => {
      arm();
      onLoaded(e.loaded);
    };
    xhr.onload = () => {
      done();
      const etag = xhr.getResponseHeader("ETag");
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new Error(`HTTP ${xhr.status}${etag ? "" : "（ETag なし）"}`));
    };
    xhr.onerror = () => {
      done();
      reject(new Error("ネットワークエラー"));
    };
    xhr.onabort = () => {
      done();
      reject(new Error(`${STALL_TIMEOUT_MS / 1000}秒間進まなかった`));
    };
    arm();
    xhr.send(body);
  });
}

async function r2UploadApi(accessToken: string, payload: Record<string, unknown>) {
  const res = await fetch("/api/director/loras/r2-upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `LoRAのアップロードに失敗しました（HTTP ${res.status}）。`);
  return data;
}

/** R2 へ上げて、そのキーを返す（生成のときに loraUploadR2Key として渡す）。 */
export async function uploadDirectorLoraFile(
  file: File,
  onProgress?: DirectorLoraUploadProgress,
): Promise<{ r2Key: string }> {
  if (!file.name.toLowerCase().endsWith(".safetensors")) {
    throw new Error(".safetensors ファイルを選んでください。");
  }
  if (file.size > DIRECTOR_LORA_MAX_BYTES) {
    throw new Error("ファイルサイズが大きすぎます（上限2GB）。");
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const cached = _uploadedLoraCache.get(file);
  if (cached) {
    onProgress?.(file.size, file.size);
    return { r2Key: cached };
  }

  const t0 = performance.now();
  const start = (await r2UploadApi(accessToken, {
    action: "start",
    filename: file.name,
    size: file.size,
  })) as { key: string; uploadId: string; partBytes: number; partUrls: string[]; releaseSig?: string };
  const loadedByPart = new Array<number>(start.partUrls.length).fill(0);
  const report = () => onProgress?.(Math.min(file.size, loadedByPart.reduce((a, b) => a + b, 0)), file.size);
  report();

  const etags = new Array<string>(start.partUrls.length);
  let next = 0;
  const worker = async () => {
    while (next < start.partUrls.length) {
      const i = next++;
      const blob = file.slice(i * start.partBytes, Math.min(file.size, (i + 1) * start.partBytes));
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
        try {
          etags[i] = await putPart(start.partUrls[i], blob, (loaded) => {
            loadedByPart[i] = loaded;
            report();
          });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          loadedByPart[i] = 0;
          report();
          console.warn(`[directorApi] LoRA part ${i + 1}/${start.partUrls.length} failed (attempt ${attempt}):`, err);
          if (attempt < PART_ATTEMPTS) await sleep(1500 * attempt);
        }
      }
      if (lastErr) {
        throw new Error(
          `LoRAのアップロードに失敗しました（${lastErr instanceof Error ? lastErr.message : String(lastErr)}）。もう一度お試しください。`,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, start.partUrls.length) }, worker));

  await r2UploadApi(accessToken, {
    action: "complete",
    key: start.key,
    uploadId: start.uploadId,
    parts: etags.map((etag, i) => ({ partNumber: i + 1, etag })),
  });
  const sec = (performance.now() - t0) / 1000;
  console.log(
    `[director-lora-upload] ${(file.size / 1e6).toFixed(1)}MB を ${sec.toFixed(1)}秒` +
      `（実効 ${((file.size * 8) / 1e6 / Math.max(sec, 0.001)).toFixed(1)} Mbps・r2・${start.partUrls.length}分割・並列${PART_CONCURRENCY}）`,
  );
  _uploadedLoraCache.set(file, start.key);
  if (start.releaseSig) {
    _uploadedThisTab.set(start.key, start.releaseSig);
    hookReleaseOnClose();
  }
  return { r2Key: start.key };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  /** reserved = 予約（順番待ち）。前のジョブが終わるとサーバーが起動して queued へ（2026-10-03）。 */
  status: "reserved" | "queued" | "processing" | "completed" | "failed";
  videoUrl: string | null;
  errorMessage: string | null;
  vramUsedGb: number | null;
  /** 出力解像度（route が生成時に metadata.out_width/out_height へ記録、2026-09-24〜）。 */
  outWidth: number | null;
  outHeight: number | null;
  combinedPrompt: string | null;
  combinedPromptJa: string | null;
  /** 動画のシード（2026-10-01〜のジョブだけ）。 */
  seed: number | null;
  /** 「作り直す」が使えるか（参照画像と台本が記録されている）。 */
  regenerable: boolean;
  /** 生成時の画質（metadata.quality_mode）。作り直しの料金表示に使う。 */
  quality: DirectorQualityMode | null;
  totalDurationS: number | null;
  /** 「顔写真として使う」で足した写真の枚数（作り直しも同じ写真を使うので、料金表示に上乗せを足す）。 */
  extraRefCount: number;
  /** 手本の動画の長さ（秒・無ければ 0）。作り直しの料金表示に上乗せを足す。 */
  refVideoDurationS: number;
  /** Photo Director のジョブか（2026-10-06）。 */
  isPhoto: boolean;
  /** 写真の署名付き URL（完了時のみ・15 分で切れるので使い回さない）。 */
  imageUrls: string[];
  queue: { queuePosition: number; avgExecutionSeconds: number; estimatedWaitSeconds: number } | null;
};

/** ジョブ行が見つからない（自動 purge 済み・別アカウントのジョブ等）。リトライしても直らないので呼び出し側で区別する。 */
export class DirectorJobNotFoundError extends Error {
  constructor() {
    super("ジョブが見つかりません。");
    this.name = "DirectorJobNotFoundError";
  }
}

export async function pollDirectorJob(jobId: string): Promise<DirectorJobStatus> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch(`/api/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (res.status === 404) throw new DirectorJobNotFoundError();
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "ジョブ状態の取得に失敗しました。");

  const meta = (data.metadata ?? {}) as {
    vram_used_gb?: unknown;
    total_duration_s?: unknown;
    out_width?: unknown;
    out_height?: unknown;
    quality_mode?: unknown;
  };
  const vramUsedGb =
    typeof meta.vram_used_gb === "number" && Number.isFinite(meta.vram_used_gb) ? meta.vram_used_gb : null;

  return {
    jobId: data.jobId as string,
    status: data.status as DirectorJobStatus["status"],
    videoUrl: (data.videoUrl as string | null) ?? null,
    errorMessage: (data.errorMessage as string | null) ?? null,
    vramUsedGb,
    outWidth: typeof meta.out_width === "number" ? meta.out_width : null,
    outHeight: typeof meta.out_height === "number" ? meta.out_height : null,
    combinedPrompt: (data.combinedPrompt as string | null) ?? null,
    combinedPromptJa: (data.combinedPromptJa as string | null) ?? null,
    seed: typeof data.seed === "number" ? data.seed : null,
    regenerable: data.regenerable === true,
    quality: isDirectorQualityMode(data.qualityMode) ? data.qualityMode : isDirectorQualityMode(meta.quality_mode) ? meta.quality_mode : null,
    totalDurationS:
      typeof data.durationS === "number" ? data.durationS : typeof meta.total_duration_s === "number" ? meta.total_duration_s : null,
    extraRefCount: typeof data.extraRefCount === "number" ? data.extraRefCount : 0,
    refVideoDurationS: typeof data.refVideoDurationS === "number" ? data.refVideoDurationS : 0,
    isPhoto: data.output === "photo",
    imageUrls: Array.isArray(data.imageUrls) ? (data.imageUrls as unknown[]).filter((u): u is string => typeof u === "string") : [],
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

/** Photo Director の「編集して作り直す」: 元のジョブの人物の写真と参照写真を File として取り戻す（2026-10-06）。 */
export async function loadPhotoJobRefs(
  jobId: string,
): Promise<{ image: File; refs: { file: File; role: DirectorRefRole }[] }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch(`/api/director/photo-refs/${jobId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || "元の写真を読み込めませんでした。");

  const toFile = async (item: { url: string; name: string }): Promise<File> => {
    const r = await fetch(item.url);
    if (!r.ok) throw new Error(`元の写真を読み込めませんでした (${r.status})`);
    const blob = await r.blob();
    // 保存名の先頭の UUID（uploadStudioAsset が付ける）は外して見せる。
    const name = item.name.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "");
    return new File([blob], name || "photo.png", { type: blob.type || "image/png" });
  };
  const refItems = (data.refs ?? []) as { url: string; name: string; role: DirectorRefRole }[];
  const [image, ...refFiles] = await Promise.all([toFile(data.main), ...refItems.map(toFile)]);
  return { image, refs: refFiles.map((file, i) => ({ file, role: refItems[i].role })) };
}
