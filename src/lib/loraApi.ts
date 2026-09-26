import { supabase } from "@/lib/supabaseClient";
import type { LoraBaseArchitecture } from "@/lib/loraModels";
import type { LoraCaptionSpec, ResolvedCaptionMode } from "@/lib/loraCaptionSpec";

// A preset id from LORA_PRESETS, or the literal "custom" (universal loader).
export type LoraTargetModel = string;

export type LoraTrainingConfigInput = {
  rank?: number;
  alpha?: number;
  learning_rate?: number;
  steps?: number;
  optimizer?: string;
  custom_yaml_override?: string;
};

// 2026-09-19: Supabase Storage バケット "lora_datasets" から Modal 直
// アップロード（modal_lora_worker.py::upload_lora_dataset_image）へ移行
// （CLAUDE.md §1標準）。返す path の形（"<userId>/<datasetId>/NNNN_name"）
// は移行前と互換のまま — /api/studio/lora/train route.ts の dataset_id
// 抽出ロジック（storagePaths[0].split("/")[1]）や Smart Ingest Engine
// （modal_lora_worker.py::_derive_dataset_id）は無改修で動く。
// 2026-09-23: 既定を Cloudflare R2 への直 PUT に切替（R2 移行 計画 4）。
// チケットが store: "r2" なら 1 枚ごとの署名付き PUT URL へ並列で送る。
// "modal" なら従来のバッチ/単枚 POST。path の形はどちらも同じ。

// Uploads the raw image files straight to Modal (bypassing Vercel's 4.5 MB
// request body cap) under "<userId>/<datasetId>/NNNN_name". The zero-padded
// index keeps the server-side sort aligned with the caption array order.
// Returns the object paths, in upload order.
export async function uploadLoraDataset(
  userId: string,
  // 送信前に WebP へ差し替えるので再代入する。
  files: File[],
  onProgress?: (done: number, total: number) => void,
  /** 送信済みバイト数（枚数カウンタより細かく動く）。 */
  onBytes?: (sent: number, total: number) => void,
  /** 送信前の WebP 変換の進捗。 */
  onOptimize?: (done: number, total: number) => void,
): Promise<{ datasetId: string; paths: string[] }> {
  const datasetId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  // 2026-09-20: 律速は帯域ではなく「1リクエストあたりの固定コスト」だった。
  // 400KB の送信に 4.3秒（=0.74Mbps/接続）かかっており、並列度を6->10に
  // 上げても実効は 7.2->7.7Mbps とほぼ動かない。そこで複数枚を1リクエストへ
  // まとめる（サーバー側の vol.commit() も枚数分から1バッチ1回に減る）。
  // 送る前にブラウザで縮小する案は逆効果で取り消した経緯が
  // docs/gpu-benchmarks.md §15 にある。
  // バッチは「枚数」ではなく「合計バイト」で切る。枚数固定だと1枚が大きい
  // データセット（1枚26MB x 10枚）でサーバーの _DATASET_BATCH_MAX_BYTES
  // (256MB) を超えて 413 になり、worker の timeout=900 にも間に合わなくなる。
  // 1枚しか入らない場合は単枚POSTと同じ形に自然に縮退する。
  const UPLOAD_BATCH_MAX_FILES = 10;
  const UPLOAD_BATCH_MAX_BYTES = 16 * 1024 * 1024;
  // 2026-09-20 実測: 131枚/52.2MB が 14リクエスト・並列4 で 46.7秒。
  // 1リクエスト平均 13.28秒 x (14/4=3.5ラウンド) = 46.5秒 と全体がぴたり
  // 一致していて、律速はサーバーでも帯域でもなく「こちらが4本しか張って
  // いないこと」。1接続あたりのスループットは単枚時代の 0.74Mbps から
  // 2.25Mbps へ既に3倍になっている。サーバー側は
  // upload_lora_dataset_batch の @modal.concurrent(max_inputs=16) まで
  // 1コンテナで受けられるので、そこへ揃えて2ラウンドで終わらせる。
  // 2026-09-20 追試: サーバー側の実処理は1リクエスト1〜3秒しかない
  // （[upload-batch] recv+write=0.02s / commit=0.9〜3.4s）。にもかかわらず
  // 1リクエストは16.93秒かかっており、差はHTTPボディの受信そのもの。
  // 上り540Mbpsの回線で3.9MBに14秒（2.2Mbps/ストリーム）は、HTTP/2 の
  // フロー制御ウィンドウ x 日米間RTT の積で説明が付く。この形の制限は
  // ストリーム数を増やすと総和が伸びるので（並列4->8 で 9.4->14.3Mbps と
  // ほぼ比例した）、リクエストを太らせるのではなく本数を増やす。
  const BATCH_CONCURRENCY = 16;
  // 単枚フォールバック経路（Modal 未デプロイ時）の並列度。
  const UPLOAD_CONCURRENCY = 10;

  // --- 送信前に WebP q95 へ変換する（2026-09-22）-----------------------------
  // ホストの実データ（1024x1536 の PNG イラスト 209枚）で **317MB -> 35MB、
  // 9倍の削減**を実測した。送信量が律速（HTTP/2 のフロー制御 x 日米間RTT、
  // docs/gpu-benchmarks.md §15）なので、ここが一番効く。
  //
  // ⚠️ §15 には「クライアント側の変換は2倍悪化」という実測がある。あれは
  // **送信と同時に**変換して canvas がメインスレッドを占有し fetch の送信を
  // 止めたケースで、しかも素材が 400KB/枚で削減率が 30% しか無かった。ここは
  // 送信を1本も張る前に変換を終わらせるので、その競合は起きない。
  // 学習側は sd-scripts がどのみちバケットへリサイズして latent 化するので、
  // q95 の損失は VAE 自身の損失よりはるかに小さい。
  const toWebp = async (f: File): Promise<File> => {
    if (/^image\/webp$/i.test(f.type)) return f;
    try {
      const bmp = await createImageBitmap(f);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bmp.close();
        return f;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.95));
      // 小さくならないなら原本を送る（既に圧縮済みの JPEG 等）。
      if (!blob || blob.size >= f.size) return f;
      const name = f.name.replace(/\.[^.]+$/, "") + ".webp";
      return new File([blob], name, { type: "image/webp", lastModified: f.lastModified });
    } catch {
      return f; // デコードできない形式は原本のまま送る
    }
  };

  // 1枚ずつ待つと 259枚で1〜2分かかる（2026-09-22、ホスト指摘「開始まで7分は
  // 遅い」）。createImageBitmap / toBlob はどちらも非同期でデコード・エンコード
  // 自体はメインスレッド外なので、数枚を同時に走らせれば実時間が縮む。
  // 並列度を上げすぎると画像を同時に何枚もメモリへ展開することになるので、
  // 4 で止める（1枚 1024x1536 の RGBA ≒ 6MB、4枚で 24MB）。
  const OPTIMIZE_CONCURRENCY = 4;
  const optimizeAll = async (): Promise<void> => {
    const optimized: File[] = new Array(files.length);
    let optimizeCursor = 0;
    let optimizeDone = 0;
    await Promise.all(
      Array.from({ length: Math.min(OPTIMIZE_CONCURRENCY, files.length) }, async () => {
        while (true) {
          const i = optimizeCursor;
          optimizeCursor += 1;
          if (i >= files.length) return;
          optimized[i] = await toWebp(files[i]);
          optimizeDone += 1;
          onOptimize?.(optimizeDone, files.length);
        }
      }),
    );
    files = optimized;
  };

  // 2026-09-24: WebP 変換は「Modal（米国）への送信量が律速」という前提の対策だった。
  // R2 はエッジ終端でその前提が無く、変換には 259 枚で 1〜2 分かかり、SDXL では
  // q95 の劣化がそのまま学習素材に残る。よって R2 経路では変換しない（Modal 経路は従来どおり）。
  // 比較計測用に localStorage `ull_lora_upload_webp=1` で R2 でも変換を強制できる。
  // 判定は同じ PNG データセットの `[lora-upload]` 行（送信秒）＋変換時間で行う。
  let forceWebp = false;
  try {
    forceWebp = window.localStorage.getItem("ull_lora_upload_webp") === "1";
  } catch {
    /* private mode 等 — 既定動作 */
  }
  const optimizeStartedAt = Date.now();
  // R2 のチケットはファイル名ごとに署名するので、変換するならチケットより前に済ませる。
  if (forceWebp) await optimizeAll();

  // "NNNN_<元のファイル名>"。ゼロ埋めの連番でサーバー側のソートが captions
  // 配列の順序と一致する（崩れると別画像のキャプションで学習が回る）。
  // WebP 変換で名前が変わる。R2 のチケットはこの名前で署名するので、R2 で変換する
  // 場合（forceWebp）はチケットより前に変換済み。Modal 経路のチケットは名前に依存しない。
  const filenameFor = (i: number): string => {
    const safe = files[i].name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "image";
    return `${String(i).padStart(4, "0")}_${safe}`;
  };

  // R2 経路はファイルごとに署名付き PUT URL が要るので、ファイル名の一覧を
  // 渡して 1 往復で全部もらう（500 枚でもサーバー内の署名計算だけ）。
  const ticketRes = await fetch("/api/studio/lora/dataset-upload-token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ datasetId, filenames: files.map((_, i) => filenameFor(i)) }),
  });
  const ticket = await ticketRes.json().catch(() => ({}));
  if (!ticketRes.ok) throw new Error(ticket?.error || "アップロード準備に失敗しました。");
  const r2Files =
    ticket.store === "r2" && Array.isArray(ticket.files) && ticket.files.length === files.length
      ? (ticket.files as { filename: string; path: string; url: string }[])
      : null;
  // Modal 経路（R2 無効時のフォールバック）は従来どおり送信前に WebP 化する。
  if (!r2Files && !forceWebp) await optimizeAll();
  const optimizeSec = (Date.now() - optimizeStartedAt) / 1000;
  // R2 は Cloudflare のエッジ終端なので、Modal（米国）への HTTP/2 フロー制御
  // × 日米間 RTT の頭打ち（§15、1 ストリーム 2.2Mbps）が無い。並列度は
  // バッチ経路と同じ 16 から始め、実測で調整する。
  const R2_CONCURRENCY = 16;
  const R2_ATTEMPTS = 3;

  const startedAt = Date.now();
  const totalBytes = files.reduce((t, f) => t + f.size, 0);
  const paths: string[] = new Array(files.length);
  let done = 0;
  let sentBytes = 0;
  let requestMs = 0;
  // 最初に失敗した「枚目」を残す（並列なので完了順は入れ替わる）。1枚でも
  // 失敗したら中止する — 部分的なデータセットで /train へ進ませない。
  let failure: { index: number; message: string } | null = null;
  // バッチ経路が無い（Modal 側が未デプロイ）と分かったら単枚でやり直す。
  let batchUnsupported = false;

  const errorText = (thrown: unknown): string =>
    thrown instanceof Error ? thrown.message : String(thrown);

  const failAt = (index: number, message: string): void => {
    if (!failure || index < failure.index) failure = { index, message };
  };

  const signedUrl = (base: string): string => {
    const url = new URL(base);
    url.searchParams.set("user_id", ticket.userId as string);
    url.searchParams.set("dataset_id", ticket.datasetId as string);
    url.searchParams.set("expires", String(ticket.expiresAt));
    url.searchParams.set("sig", ticket.sig as string);
    return url.toString();
  };

  // 進捗はバイト単位で出す（2026-09-22、ホスト報告「0/209 のまま全然進まない」）。
  // fetch だと送信の進捗が取れず、1リクエスト130〜150秒 x 16並列なので
  // 最初の完了まで2分以上カウンタが 0 のまま動かない。XHR なら upload.onprogress
  // で実際に送ったバイト数が分かるので、止まっているのか進んでいるのかが見える。
  const inflightBytes = new Map<number, number>();
  const reportBytes = (): void => {
    let partial = 0;
    for (const v of inflightBytes.values()) partial += v;
    onBytes?.(sentBytes + partial, totalBytes);
  };

  // 1バッチの一時的な切断で全体を捨てない（2026-09-22、ホスト報告
  // 「Failed to fetch（11/209 枚目〜）」）。サーバー側のログでは当該
  // ハンドラは正常に完走しており、応答だけが返らなかった。16本の大きな
  // multipart を同時に張るので、経路のどこかでストリームが落ちるのは
  // 起こり得る。3分かけたアップロードを1回の瞬断で捨てるのは割に合わない。
  const BATCH_ATTEMPTS = 3;

  const uploadBatchOnce = async (indexes: number[]): Promise<unknown> => {
    const form = new FormData();
    let batchBytes = 0;
    for (const i of indexes) {
      form.append("files", files[i], filenameFor(i));
      batchBytes += files[i].size;
    }

    const startedRequestAt = Date.now();
    let thrown: unknown = null;
    let lastResponseText = "";
    const key = indexes[0];
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", signedUrl(ticket.batchUploadUrl as string), true);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            inflightBytes.set(key, Math.min(e.loaded, batchBytes));
            reportBytes();
          }
        };
        xhr.onerror = () => reject(new Error("ネットワークエラー（接続が切れました）"));
        xhr.ontimeout = () => reject(new Error("タイムアウトしました"));
        xhr.onabort = () => reject(new Error("中断されました"));
        xhr.onload = () => {
          lastResponseText = xhr.responseText || "";
          resolve(xhr.status);
        };
        // サーバー側は commit に最大30秒ほど使う。送信後の待ちも含めて余裕を取る。
        xhr.timeout = 10 * 60 * 1000;
        xhr.send(form);
      });
      if (status === 404 || status === 405) {
        batchUnsupported = true;
        inflightBytes.delete(key);
        return null;
      }
      if (status < 200 || status >= 300) {
        // サーバーの detail を読み捨てない（2026-09-22）。fetch から XHR へ
        // 切り替えた際に落としてしまい、400 の理由が分からなくなっていた。
        let detail = "";
        try {
          const body = JSON.parse(lastResponseText || "{}") as { detail?: string; error?: string };
          detail = (body.detail || body.error || "").toString();
        } catch {
          detail = (lastResponseText || "").slice(0, 200);
        }
        thrown = new Error(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
      }
    } catch (err) {
      thrown = err;
    }
    inflightBytes.delete(key);
    if (thrown) return thrown;

    requestMs += Date.now() - startedRequestAt;
    sentBytes += batchBytes;
    for (const i of indexes) paths[i] = `${userId}/${datasetId}/${filenameFor(i)}`;
    done += indexes.length;
    onProgress?.(done, files.length);
    reportBytes();
    return null;
  };

  const uploadBatch = async (indexes: number[]): Promise<void> => {
    let last: unknown = null;
    for (let attempt = 1; attempt <= BATCH_ATTEMPTS; attempt++) {
      last = await uploadBatchOnce(indexes);
      if (last === null || batchUnsupported) return;
      if (attempt < BATCH_ATTEMPTS) {
        console.warn(
          `[lora] upload batch @${indexes[0]} failed (attempt ${attempt}/${BATCH_ATTEMPTS}):`,
          last,
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    const first = indexes[0];
    failAt(
      first,
      `${files[first].name}（${first + 1}/${files.length} 枚目〜）: ${errorText(last)}` +
        `（${BATCH_ATTEMPTS} 回試しました）`,
    );
  };

  const uploadOne = async (i: number): Promise<void> => {
    const file = files[i];
    const url = new URL(signedUrl(ticket.uploadUrl as string));
    url.searchParams.set("filename", filenameFor(i));

    const startedRequestAt = Date.now();
    let thrown: unknown = null;
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": file.type || "image/png" },
        body: file,
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}) as { detail?: string; error?: string });
        thrown = new Error(detail?.detail || detail?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      thrown = err;
    }

    if (thrown) {
      failAt(i, `${file.name}（${i + 1}/${files.length} 枚目）: ${errorText(thrown)}`);
      return;
    }

    requestMs += Date.now() - startedRequestAt;
    sentBytes += file.size;
    paths[i] = `${userId}/${datasetId}/${filenameFor(i)}`;
    done += 1;
    onProgress?.(done, files.length);
  };

  // R2 直 PUT（1 枚 1 リクエスト）。XHR なのは送信進捗を取るため。
  // 瞬断は 3 回まで再送し、4xx（署名切れ・キー不正）は即座に諦める。
  const uploadOneR2 = async (i: number): Promise<void> => {
    const file = files[i];
    const entry = (r2Files as { filename: string; path: string; url: string }[])[i];
    let last: unknown = null;
    for (let attempt = 1; attempt <= R2_ATTEMPTS; attempt++) {
      const startedRequestAt = Date.now();
      try {
        const status = await new Promise<number>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", entry.url, true);
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              inflightBytes.set(i, Math.min(e.loaded, file.size));
              reportBytes();
            }
          };
          xhr.onerror = () => reject(new Error("ネットワークエラー（接続が切れました）"));
          xhr.ontimeout = () => reject(new Error("タイムアウトしました"));
          xhr.onabort = () => reject(new Error("中断されました"));
          xhr.onload = () => resolve(xhr.status);
          xhr.timeout = 10 * 60 * 1000;
          xhr.send(file);
        });
        if (status >= 200 && status < 300) {
          inflightBytes.delete(i);
          requestMs += Date.now() - startedRequestAt;
          sentBytes += file.size;
          paths[i] = entry.path;
          done += 1;
          onProgress?.(done, files.length);
          reportBytes();
          return;
        }
        last = new Error(`HTTP ${status}`);
        if (status >= 400 && status < 500) break;
      } catch (err) {
        last = err;
      }
      inflightBytes.delete(i);
      if (attempt < R2_ATTEMPTS) {
        console.warn(`[lora] R2 upload #${i} failed (attempt ${attempt}/${R2_ATTEMPTS}):`, last);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    failAt(i, `${file.name}（${i + 1}/${files.length} 枚目）: ${errorText(last)}`);
  };

  const runPool = async <T,>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> => {
    let cursor = 0;
    const runner = async (): Promise<void> => {
      while (failure === null && !batchUnsupported) {
        const i = cursor;
        cursor += 1;
        if (i >= items.length) return;
        await worker(items[i]);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => runner()),
    );
  };

  const indexes = files.map((_, i) => i);
  let route = "single";
  let batchCount = 0;

  if (r2Files) {
    route = "r2";
    await runPool(indexes, R2_CONCURRENCY, uploadOneR2);
  } else if (ticket.batchUploadUrl) {
    const batches: number[][] = [];
    let current: number[] = [];
    let currentBytes = 0;
    for (const i of indexes) {
      const size = files[i].size;
      // 空のバッチには必ず1枚入れる（1枚が上限を超えていても送れるように）。
      if (
        current.length > 0 &&
        (current.length >= UPLOAD_BATCH_MAX_FILES || currentBytes + size > UPLOAD_BATCH_MAX_BYTES)
      ) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(i);
      currentBytes += size;
    }
    if (current.length > 0) batches.push(current);
    batchCount = batches.length;
    route = "batch";
    await runPool(batches, BATCH_CONCURRENCY, uploadBatch);
    if (batchUnsupported) {
      // Vercel だけ先に上がって Modal が未デプロイのときに来る。最初からやり直す
      // （書けた分は同じパスへ上書きされるので、残骸にはならない）。
      route = "single(batch未対応)";
      done = 0;
      sentBytes = 0;
      requestMs = 0;
      onProgress?.(0, files.length);
    }
  }

  if (route !== "batch" && route !== "r2") {
    batchUnsupported = false;
    await runPool(indexes, UPLOAD_CONCURRENCY, uploadOne);
  }

  if (failure !== null) throw new Error((failure as { message: string }).message);

  // 実効スループットの計測。1リクエスト平均秒が、1枚あたりの固定コストが
  // 残っているかどうかの判断材料になる（§15 の時点では 400KB で 4.3秒）。
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const mbps = elapsedSec > 0 ? (sentBytes * 8) / elapsedSec / 1e6 : 0;
  const requests = route === "batch" ? batchCount : files.length;
  console.info(
    `[lora-upload] ${files.length}枚 / ${(sentBytes / 1048576).toFixed(1)}MB を ` +
      `${elapsedSec.toFixed(1)}秒（実効 ${mbps.toFixed(1)} Mbps・${route}・` +
      `${requests}リクエスト・1リクエスト平均 ${(requestMs / Math.max(1, requests) / 1000).toFixed(2)}秒` +
      `・WebP ${forceWebp || !r2Files ? `あり（変換+準備 ${optimizeSec.toFixed(1)}秒）` : "なし"}）`,
  );

  return { datasetId, paths };
}

export type StartLoraTrainingParams = {
  // 実行速度。"fast" は高速 tier がある arch（loraFastOption）でだけ効き、料金もその tier で決まる。
  speed?: "standard" | "fast";
  /** 学習中にもう 1 本出す（並列・追加料金、2026-09-26）。 */
  priority?: boolean;
  // Supabase Storage object paths (from uploadLoraDataset), in caption order.
  storagePaths: string[];
  captions: string[];
  // 画像ごとの学習回数（storagePaths と同じ並び）。kohya のフォルダ名規約
  // "10_name" と同じ意味。未指定・全要素1 なら重み付けなし。
  // ⚠️ 総ステップ数は固定なので消費クレジットは変わらない。
  repeats?: number[];
  /** 画像ごとの keep_tokens（SDXL のみ）。キャプションから自動算出した値。 */
  keepTokensPerImage?: number[];
  /** 2 人目以降のトリガー（複数人物のジョブだけ）。 */
  extraTriggers?: string[];
  targetModel: LoraTargetModel;
  // Universal loader — required when targetModel === "custom".
  customModelId?: string;
  baseArchitecture?: LoraBaseArchitecture;
  trainingConfig: LoraTrainingConfigInput;
  // Training resolution (512 / 768 / 1024). Default 768.
  resolution?: number;
  outputLoraName: string;
  triggerWord: string;
  // Set when the user supplied their own captions (semi-auto edits, or a
  // .txt set): the worker then skips loading the 27B caption VLM entirely.
  customCaptions?: string[];
  skipCaptioning?: boolean;
  // Resolved caption FORMAT ("dense" | "tags") for the selected base model.
  // Forwarded to the worker so the persisted-caption cache is keyed per
  // format — a dense run and a tags run of the same dataset never collide.
  captionMode?: ResolvedCaptionMode;
  // The user's own instruction for the auto-caption VLM (category preset or
  // free-text). Empty / omitted -> the worker's default character prompt.
  captionPrompt?: string;
  // The structured LoRA-type spec (人物 / 衣装 / 物体 / 背景 / 画風 ＋ 固定/変化させ
  // たい特徴の日本語). The server rebuilds captionPrompt from this when the
  // browser didn't send a generated one.
  captionSpec?: LoraCaptionSpec;
  // SDXL/sd-scriptsワーカー限定（[[sdxl-training-sd-scripts-plan]]）:
  // "tag:freq,tag,..." 形式の手動メタデータタグ埋め込み。サーバー側
  // (isSdxlJob以外では常に無視)と worker の _parse_embed_tags を参照。
  embedTags?: string;
  keepTokens?: number;
};

export type LoraApiError = Error & { remainingCredits?: number; requiredCredits?: number };

export type LoraStartResult = { jobId: string; remainingCredits: number; modalCallId: string | null };

export async function startLoraTraining(params: StartLoraTrainingParams): Promise<LoraStartResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch("/api/studio/lora/train", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      storage_paths: params.storagePaths,
      captions: params.captions,
      ...(params.repeats?.some((n) => n !== 1) ? { repeats: params.repeats } : {}),
      ...(params.keepTokensPerImage?.some((n, _i, a) => n !== a[0])
        ? { keep_tokens_per_image: params.keepTokensPerImage }
        : {}),
      target_model: params.targetModel,
      custom_model_id: params.customModelId,
      base_architecture: params.baseArchitecture,
      training_config: params.trainingConfig,
      resolution: params.resolution,
      output_lora_name: params.outputLoraName,
      trigger_word: params.triggerWord,
      ...(params.extraTriggers?.length ? { extra_triggers: params.extraTriggers } : {}),
      custom_captions: params.customCaptions,
      skip_captioning: params.skipCaptioning,
      caption_mode: params.captionMode,
      caption_prompt: params.captionPrompt,
      caption_spec: params.captionSpec,
      embed_tags: params.embedTags,
      keep_tokens: params.keepTokens,
      ...(params.speed === "fast" ? { speed: "fast" } : {}),
      ...(params.priority ? { priority: true } : {}),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason =
      typeof data?.reason === "string"
        ? data.reason
        : data?.details && typeof data.details === "object" && typeof data.details.message === "string"
          ? data.details.message
          : typeof data?.details === "string"
            ? data.details
            : "";
    const base = data?.error || "LoRA学習の開始に失敗しました。";
    const error: LoraApiError = new Error(reason ? `${base}（${reason}）` : base);
    if (typeof data?.remainingCredits === "number") error.remainingCredits = data.remainingCredits;
    if (typeof data?.requiredCredits === "number") error.requiredCredits = data.requiredCredits;
    throw error;
  }
  return {
    jobId: data.jobId as string,
    remainingCredits: data.remainingCredits as number,
    modalCallId: (data.modalCallId as string | null) ?? null,
  };
}

export type LoraCheckpoint = {
  step: number;
  filename: string;
  sizeBytes: number;
  isFinal: boolean;
  // true for the dataset bundle (training images + their .txt captions;
  // older jobs: captions-only captions.zip) — shown as its own download
  // button, not in the intermediate-checkpoint list.
  isCaptionArchive: boolean;
  // true for checkpoints_all.zip — every .safetensors checkpoint in one
  // archive. Its own "download all" button, not in the per-step list.
  isBundle: boolean;
};

export type LoraJobStatus = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled" | "failed_timeout";
  errorMessage: string | null;
  resultPath: string | null;
  progressPercent: number | null;
  progressMessage: string | null;
  retryCount: number;
  // Live effective VRAM load (GB) — spoiler-free, no total / GPU model.
  vramUsedGb: number | null;
  // Live Stage-2 (ai-toolkit) training telemetry, parsed from tqdm output.
  // null until the trainer's progress bar starts emitting.
  currentStep: number | null;
  totalSteps: number | null;
  etaSeconds: number | null;
  loss: number | null;
  // Ring buffer of the ~40 most recent worker stdout/stderr lines (each
  // "HH:MM:SS  message"), for the collapsible Live Terminal. null on older
  // jobs / before the trainer starts emitting.
  logs: string[] | null;
  // Intermediate + final LoRA checkpoints, available once completed.
  checkpoints: LoraCheckpoint[];
  // On a 'failed' job: whether the consumed credits were refunded. null when
  // unknown (older jobs / column absent). Raw-YAML config errors are NOT
  // refunded (platform-defence policy), standard GUI-mode faults are.
  refunded: boolean | null;
  customYaml: boolean;
  // The system stopped the run early to protect cost (prep deadlock, or the
  // projected time would exceed what the paid credits cover). Always refunded.
  safetyStop: boolean;
  safetyKind: "cost" | "prep" | null;
  queue:
    | { queuePosition: number; avgExecutionSeconds: number; estimatedWaitSeconds: number }
    | null;
};

// A pollLoraJob failure, tagged so the caller's polling loop can decide
// whether to keep retrying (indexed backoff) or stop:
//   isTransient — a 5xx from the API, or fetch itself rejected (offline /
//     DNS / connection reset / timeout). The job is fine server-side; retry.
//   isFatal     — a definitive 404: the job row is gone or belongs to another
//     account. No amount of retrying fixes it — stop + drop the saved pointer.
export type LoraPollError = Error & {
  status?: number;
  isTransient?: boolean;
  isFatal?: boolean;
};

export async function pollLoraJob(jobId: string): Promise<LoraJobStatus> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  let res: Response;
  try {
    res = await fetch(`/api/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch (netErr) {
    // fetch rejected outright — offline, DNS failure, connection reset, the
    // request timed out. Always transient: the job lives on server-side, we
    // just couldn't reach it this tick.
    const err = new Error(
      netErr instanceof Error ? `通信エラー: ${netErr.message}` : "通信エラー",
    ) as LoraPollError;
    err.isTransient = true;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Tag the HTTP status so callers can tell a definitive 404 (job gone /
    // wrong account) from a transient 5xx / network error — the mount-restore
    // path only drops its saved job pointer on the former, and the polling
    // loop keeps retrying the latter with exponential backoff.
    const err = new Error(data?.error || "ジョブ状態の取得に失敗しました。") as LoraPollError;
    err.status = res.status;
    if (res.status === 404) err.isFatal = true;
    else if (res.status >= 500) err.isTransient = true;
    throw err;
  }

  const meta = (data.metadata ?? {}) as {
    vram_used_gb?: unknown;
    checkpoints?: unknown;
    refunded?: unknown;
    custom_yaml?: unknown;
    safety_stop?: unknown;
    safety_kind?: unknown;
    current_step?: unknown;
    total_steps?: unknown;
    eta_seconds?: unknown;
    loss?: unknown;
    logs?: unknown;
  };
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const logs: string[] | null = Array.isArray(meta.logs)
    ? (meta.logs as unknown[]).filter((l): l is string => typeof l === "string").slice(-60)
    : null;
  const checkpoints: LoraCheckpoint[] = Array.isArray(meta.checkpoints)
    ? (meta.checkpoints as Record<string, unknown>[])
        .map((c) => ({
          step: typeof c.step === "number" ? c.step : 0,
          filename: typeof c.filename === "string" ? c.filename : "",
          sizeBytes: typeof c.size_bytes === "number" ? c.size_bytes : 0,
          isFinal: c.is_final === true,
          isCaptionArchive: c.is_caption_archive === true,
          isBundle: c.is_bundle === true,
        }))
        .filter((c) => c.filename)
    : [];

  return {
    jobId: data.jobId as string,
    status: data.status as LoraJobStatus["status"],
    errorMessage: (data.errorMessage as string | null) ?? null,
    resultPath: (data.resultPath as string | null) ?? null,
    progressPercent: (data.progressPercent as number | null) ?? null,
    progressMessage: (data.progressMessage as string | null) ?? null,
    retryCount: (data.retryCount as number | undefined) ?? 0,
    vramUsedGb: num(meta.vram_used_gb),
    currentStep: num(meta.current_step),
    totalSteps: num(meta.total_steps),
    etaSeconds: num(meta.eta_seconds),
    loss: num(meta.loss),
    logs,
    checkpoints,
    refunded: typeof meta.refunded === "boolean" ? meta.refunded : null,
    customYaml: meta.custom_yaml === true,
    safetyStop: meta.safety_stop === true,
    safetyKind:
      meta.safety_kind === "cost" || meta.safety_kind === "prep" ? meta.safety_kind : null,
    queue:
      typeof data.queuePosition === "number"
        ? {
            queuePosition: data.queuePosition as number,
            avgExecutionSeconds: (data.avgExecutionSeconds as number | undefined) ?? 0,
            estimatedWaitSeconds: (data.estimatedWaitSeconds as number | undefined) ?? 0,
          }
        : null,
  };
}

// Asks /api/studio/lora/checkpoint (bearer-auth'd) for a short-lived signed
// Modal URL, then navigates the browser straight to it — the actual bytes
// flow browser<->Modal directly (Content-Disposition: attachment on
// Modal's FileResponse makes the cross-origin nav download rather than
// navigate), not through this app's server. A prior version fetched the
// file here and re-served it as a blob: fine for small assets, but a
// 600MB+ checkpoint doubles every byte's hop count and was timing out
// (NGHTTP2_INTERNAL_ERROR) partway through the transfer.
// Asks /api/studio/lora/checkpoint (bearer-auth'd) for the short-lived
// signed Modal URL and returns it — used by both the direct-download button
// and the "copy URL for the Model Downloader" button. The link is valid for
// ~15 minutes and the bytes flow browser<->Modal directly (one hop).
// Current access token, force-refreshed if it's within 60s of expiring — so a
// download started from a completed screen that sat open doesn't 401.
async function freshAccessToken(): Promise<string> {
  let token: string | undefined;
  try {
    const { data } = await supabase.auth.getSession();
    token = data.session?.access_token;
    const exp = data.session?.expires_at ?? 0;
    if (!token || exp * 1000 < Date.now() + 60_000) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      token = refreshed.session?.access_token ?? token;
    }
  } catch {
    /* fall through */
  }
  if (!token) {
    throw new Error("セッションの有効期限が切れました。ページを再読み込みしてログインし直してください。");
  }
  return token;
}

// Hands a signed, cross-origin download URL straight to the browser's own
// download manager.
//
// A same-frame top-level navigation is the robust trigger: the Modal endpoint
// answers with `Content-Disposition: attachment` (+ `Content-Length` +
// `Accept-Ranges: bytes`), so the browser hands the response to its download
// manager and the page itself never leaves — and, unlike a programmatic
// `<a download>.click()`, a navigation is NEVER gated behind *transient user
// activation*. That gate is exactly what silently swallowed downloads here:
// `freshAccessToken()` + the signing round-trip can take >5s on a poor
// connection, by which point the click's activation budget is spent and
// Chrome/Edge drop the download with only a console warning. `location.assign`
// has no such budget. The `download` attribute was cross-origin-ignored
// anyway, so nothing is lost. Range-aware, so a dropped connection resumes.
function triggerBrowserDownload(url: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(url);
}

function mapDownloadError(status: number, error?: string): Error {
  if (status === 401) return new Error("認証の有効期限が切れました。再読み込みしてお試しください。");
  if (status === 403) return new Error(error || "このジョブのダウンロード権限がありません。");
  if (status === 404) return new Error(error || "対象ファイルがまだ準備されていません。");
  return new Error(error || `ダウンロードURLの取得に失敗しました (${status})。`);
}

export async function getLoraCheckpointDownloadUrl(jobId: string, filename: string): Promise<string> {
  const accessToken = await freshAccessToken();
  const res = await fetch(
    `/api/studio/lora/checkpoint?jobId=${encodeURIComponent(jobId)}&file=${encodeURIComponent(filename)}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.downloadUrl !== "string") throw mapDownloadError(res.status, data?.error);
  return data.downloadUrl as string;
}

export async function downloadLoraCheckpoint(jobId: string, filename: string): Promise<void> {
  triggerBrowserDownload(await getLoraCheckpointDownloadUrl(jobId, filename));
}

// Kicks off several cross-origin attachment downloads at once. Each URL goes
// into its own hidden <iframe>: an iframe navigation is not gated behind
// transient user activation (a programmatic <a>.click() after the signing
// round-trip is, and gets silently dropped), and the `Content-Disposition:
// attachment` response hands each one to the browser's download manager.
// Chrome asks once for "download multiple files" permission on this origin.
function triggerMultiDownload(urls: string[]): void {
  if (typeof document === "undefined") return;
  urls.forEach((url, i) => {
    window.setTimeout(() => {
      const f = document.createElement("iframe");
      f.style.display = "none";
      f.src = url;
      document.body.appendChild(f);
      // Keep it around long enough for the download to be handed off.
      window.setTimeout(() => f.remove(), 120_000);
    }, i * 300);
  });
}

export type LoraSelectionDownload =
  // Legacy (Volume) jobs: the worker stitches the selection into one
  // uncompressed zip and streams it — a single URL.
  | { bundled: true; url: string }
  // R2 jobs: one presigned URL per file; nothing to unzip.
  | { bundled: false; files: { filename: string; url: string; sizeBytes: number | null }[] };

// Asks the selection route for the download(s) of a 2+ file selection. The
// route validates every name against generation_jobs.metadata.checkpoints for
// the owning job, then either mints N presigned R2 URLs (post-migration jobs)
// or one HMAC-signed Modal zip URL (pre-migration jobs).
export async function getLoraSelectionDownload(
  jobId: string,
  filenames: string[],
): Promise<LoraSelectionDownload> {
  const accessToken = await freshAccessToken();
  const res = await fetch(
    `/api/studio/lora/checkpoint/selection?jobId=${encodeURIComponent(jobId)}&files=${encodeURIComponent(
      filenames.join(","),
    )}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw mapDownloadError(res.status, data?.error);
  if (data?.store === "r2" && Array.isArray(data.files)) {
    const files = (data.files as { filename?: unknown; url?: unknown; sizeBytes?: unknown }[])
      .filter((f) => typeof f.filename === "string" && typeof f.url === "string")
      .map((f) => ({
        filename: f.filename as string,
        url: f.url as string,
        sizeBytes: typeof f.sizeBytes === "number" ? f.sizeBytes : null,
      }));
    if (files.length === 0) throw mapDownloadError(res.status, data?.error);
    return { bundled: false, files };
  }
  if (typeof data?.downloadUrl !== "string") throw mapDownloadError(res.status, data?.error);
  return { bundled: true, url: data.downloadUrl as string };
}

// Starts the selection download. Returns whether the server bundled it into
// one zip (legacy) — the caller uses that to decide how long "preparing"
// should show, since a zip build blocks the browser for ~30-60s first.
export async function downloadLoraSelection(
  jobId: string,
  filenames: string[],
): Promise<{ bundled: boolean }> {
  const sel = await getLoraSelectionDownload(jobId, filenames);
  if (sel.bundled) {
    triggerBrowserDownload(sel.url);
    return { bundled: true };
  }
  triggerMultiDownload(sel.files.map((f) => f.url));
  return { bundled: false };
}

// One signed URL per file, in the order given — for the "URL 一覧をコピー"
// button (paste into aria2 / a download manager). Works for both stores: the
// checkpoint route returns an R2 presigned URL when the entry has r2_key and
// a Modal signed URL otherwise. All links are valid for ~15 minutes.
export async function getLoraCheckpointDownloadUrls(jobId: string, filenames: string[]): Promise<string[]> {
  return Promise.all(filenames.map((f) => getLoraCheckpointDownloadUrl(jobId, f)));
}

// One-shot smart artefact download. The API probes the Volume server-side
// (recursive search across loras/<user>/<job_id|call_id>/, salvaged_ names,
// on-demand zip) and returns a signed streaming URL only when the file
// genuinely exists — a real miss is a 404 here, surfaced as a toast, not a
// silent failed download.
export async function downloadLoraJobBundle(
  jobId: string,
  want: "final" | "bundle" | "dataset" = "bundle",
): Promise<void> {
  const accessToken = await freshAccessToken();
  const res = await fetch(
    `/api/studio/lora/checkpoint/bundle?jobId=${encodeURIComponent(jobId)}&want=${want}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data?.downloadUrl !== "string") {
    if (res.status === 404) throw new Error(data?.error || "ダウンロード対象が見つかりません。");
    throw mapDownloadError(res.status, data?.error);
  }
  triggerBrowserDownload(data.downloadUrl as string);
}

// Lightweight "does this artefact actually exist?" check. Hits the same
// smart-resolve endpoint as downloadLoraJobBundle (recursive Volume probe,
// salvaged_ names, on-demand zip candidates) but NEVER starts a download —
// it just reports whether the file is there. Used to gate the 完成版 /
// 全チェックポイント download buttons on a failed job so we don't show a
// download for something a Step-0 init crash never produced.
export async function probeLoraJobArtifact(
  jobId: string,
  want: "final" | "bundle" | "dataset",
): Promise<boolean> {
  const accessToken = await freshAccessToken();
  const res = await fetch(
    `/api/studio/lora/checkpoint/bundle?jobId=${encodeURIComponent(jobId)}&want=${want}`,
    { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
  );
  if (res.status === 404) return false;
  const data = await res.json().catch(() => ({}));
  return res.ok && typeof data?.downloadUrl === "string";
}

export type LoraRecoverResult = {
  ok: boolean;
  status?: string;
  jobId?: string; // set when a retry produced a fresh job to poll
  retryCount?: number;
  refunded?: number; // credits returned when it escalated to failed_timeout
  modalCancelled?: boolean; // whether Modal confirmed the physical .cancel()
  customYaml?: boolean; // true -> raw-YAML job, credits NOT refunded
  noop?: boolean;
};

// Ends a stuck / unwanted job: physically cancels the Modal call (terminating
// its GPU container) and 100%-refunds the cost. "abort" also reaches a job
// that's already 'processing' (-> 'cancelled'); "timeout" -> 'failed_timeout'.
//
// NOT wired to any user-facing UI — the LoRA Studio screen is monitor-only.
// Kept for admin / internal / manual recovery use (call the /api/studio/lora
// /recover route directly, or from a future admin panel).
export async function recoverLoraJob(
  jobId: string,
  action: "timeout" | "abort",
): Promise<LoraRecoverResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch("/api/studio/lora/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jobId, action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.reason || "リカバリに失敗しました。");
  return data as LoraRecoverResult;
}

export type RecentLoraJob = {
  jobId: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
};

// The user's most recent LoRA Studio job — used to re-attach after the
// localStorage pointer was lost. Returns null when they've never run one.
export async function fetchRecentLoraJob(): Promise<RecentLoraJob | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return null;

  const res = await fetch("/api/studio/lora/recent", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const job = data?.job;
  return job && typeof job.jobId === "string" ? (job as RecentLoraJob) : null;
}

export type LoraSalvageResult = {
  ok: boolean;
  // Number of .safetensors recovered (excludes the dataset archive).
  salvaged: number;
  // Files bundled into dataset_salvaged.zip.
  captionFiles: number;
  imageFiles: number;
  // Recovered artifacts — download via downloadLoraCheckpoint / the signed
  // URL, exactly like a completed job's checkpoints.
  checkpoints: LoraCheckpoint[];
};

// Asks the salvage API to scan the Volume for whatever a failed / cancelled
// job left behind (intermediate weights + persisted captions) and register
// them for download. Safe to call more than once — it's idempotent.
export async function salvageLoraJob(jobId: string): Promise<LoraSalvageResult> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("ログインが必要です。");

  const res = await fetch("/api/studio/lora/salvage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jobId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.reason || "救出処理に失敗しました。");

  const rawCkpts = Array.isArray(data.checkpoints)
    ? (data.checkpoints as Record<string, unknown>[])
    : [];
  const checkpoints: LoraCheckpoint[] = rawCkpts
    .map((c) => ({
      step: typeof c.step === "number" ? c.step : 0,
      filename: typeof c.filename === "string" ? c.filename : "",
      sizeBytes: typeof c.size_bytes === "number" ? c.size_bytes : 0,
      isFinal: c.is_final === true,
      isCaptionArchive: c.is_caption_archive === true,
      isBundle: c.is_bundle === true,
    }))
    .filter((c) => c.filename);

  return {
    ok: data.ok === true,
    salvaged: typeof data.salvaged === "number" ? data.salvaged : 0,
    captionFiles: typeof data.captionFiles === "number" ? data.captionFiles : 0,
    imageFiles: typeof data.imageFiles === "number" ? data.imageFiles : 0,
    checkpoints,
  };
}
