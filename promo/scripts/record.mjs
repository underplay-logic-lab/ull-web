// 操作動画の録画（docs/promo-video-storyboard.md C）。
//
// ブラウザを開くので、人がそのまま操作する。閉じたら保存して終わり。
//   node scripts/record.mjs login                 … 録画せずに開く（テスト用アカウントでログインしておく）
//   node scripts/record.mjs <名前> [開くURL]       … 録画（例: node scripts/record.mjs dataset https://www.ullstudio.com/studio?tab=dataset）
//
// Playwright 標準の録画は画質が低い（ズームすると文字が潰れる）ので、CDP の screencast で
// 画面が変わったときだけ JPEG を保存する。カーソルは写らないので、マウスの位置とクリックを記録して
// Remotion 側で描く（src/tutorial/）。キーは「押した」ことだけ記録し、何を打ったかは残さない（パスワード対策）。
// F8 で「ここで説明を入れる」目印。入力欄が出るので、入れたいテロップをメモする（Enter で確定・Esc で取り消し）。
// 入力欄が出ている間は録画を止めて、その時間ごと動画から抜く。edit.json に memo 付きの空欄として書き出す。
//
// 出力: public/rec/<名前>/frames/*.jpg・session.json・edit.json（既にあれば上書きしない）
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [name, startUrl = "https://www.ullstudio.com/studio"] = process.argv.slice(2);
if (!name) {
  console.error("使い方: node scripts/record.mjs login | <名前> [開くURL]");
  process.exit(1);
}

// 見せる画面の大きさ（CSS px）。書き出しは 1920×1080 なので同じ比率にする。
// DPR を上げるとズームしても文字が読める（2 で 3200×1800 の JPEG。1.5 だと 1440p 書き出しで拡大時に粗い、2026-10-02）。
const VIEW = { width: 1600, height: 900 };
const DPR = Number(process.env.REC_DPR ?? 2);
const QUALITY = Number(process.env.REC_QUALITY ?? 88);

const profileDir = path.join(root, ".rec-profile");
const recording = name !== "login";

// ログインは自動操作をつながない普通の Chrome で、録画と同じプロファイルを開く。
// Playwright でつないだままだと、起動オプションで印を消してもログイン画面の Turnstile に弾かれる（エラー 600010、2026-10-01）。
// Turnstile が出るのはログイン画面だけなので、一度ログインしておけば録画中は当たらない。
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (!recording && fs.existsSync(CHROME)) {
  const { spawn } = await import("node:child_process");
  console.log("ログインしたらブラウザを閉じてください（録画はしていません）。");
  const chrome = spawn(CHROME, [`--user-data-dir=${profileDir}`, "--no-first-run", "--hide-crash-restore-bubble", startUrl], { stdio: "ignore" });
  await new Promise((r) => chrome.on("exit", r));
  process.exit(0);
}

const launch = (channel) =>
  chromium.launchPersistentContext(profileDir, {
    channel,
    headless: false,
    viewport: VIEW,
    deviceScaleFactor: DPR,
    locale: "ja-JP",
    // 自動操作の印（navigator.webdriver・「自動テストソフトウェアによって制御」）を消す。
    // 付いたままだとログイン画面の Turnstile（Cloudflare のロボット判定）に弾かれる（2026-10-01）。
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--hide-crash-restore-bubble", "--disable-blink-features=AutomationControlled"],
  });
// 普段の Chrome があればそれを使う（無ければ Playwright 同梱の Chromium）。
const context = await launch("chrome").catch(() => launch(undefined));
const page = context.pages()[0] ?? (await context.newPage());

if (!recording) {
  await page.goto(startUrl);
  console.log("ログインしたらブラウザを閉じてください（録画はしていません）。");
  await new Promise((r) => context.on("close", r));
  process.exit(0);
}

const outDir = path.join(root, "public", "rec", name);
const framesDir = path.join(outDir, "frames");
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const t0 = Date.now();
// メモ入力で止めた区間は時間ごと詰める。止めている間のフレーム・操作は null（捨てる）。
const pauses = [];
let pausedAt = null;
const rel = (ms) => {
  let off = 0;
  for (const [a, b] of pauses) {
    if (ms >= b) off += b - a;
    else if (ms >= a) return null;
  }
  if (pausedAt !== null && ms >= pausedAt) return null;
  return Math.max(0, Math.round(ms - t0 - off));
};
const frames = [];
const events = [];

// ページ側: マウス・クリック・スクロール・キー・F8 を node へ送る。
await page.exposeBinding("__rec", (_src, e) => {
  if (e.type === "pause") pausedAt ??= e.t;
  else if (e.type === "resume") {
    if (pausedAt !== null) pauses.push([pausedAt, e.t]);
    pausedAt = null;
  } else {
    const t = rel(e.t);
    if (t !== null) events.push({ ...e, t });
  }
});
await page.addInitScript(() => {
  if (window.__recInstalled) return;
  window.__recInstalled = true;
  const send = (e) => window.__rec?.({ ...e, t: Date.now() });
  let lastMove = 0;
  addEventListener(
    "mousemove",
    (e) => {
      const now = performance.now();
      if (now - lastMove < 33) return;
      lastMove = now;
      send({ type: "move", x: e.clientX, y: e.clientY });
    },
    true,
  );
  addEventListener(
    "mousedown",
    (e) => {
      const el = e.target instanceof Element ? e.target.closest("button,a,label,input,select,textarea,[role]") ?? e.target : null;
      const label = (el?.getAttribute?.("aria-label") || el?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
      send({ type: "click", x: e.clientX, y: e.clientY, label });
    },
    true,
  );
  let lastWheel = 0;
  addEventListener(
    "wheel",
    () => {
      const now = performance.now();
      if (now - lastWheel < 250) return;
      lastWheel = now;
      send({ type: "scroll" });
    },
    { capture: true, passive: true },
  );
  // F8: 録画を止めてメモ欄を出す。閉じたら画面から消えるのを待ってから再開する（欄が写り込まないように）。
  let memoOpen = false;
  const openMemo = () => {
    memoOpen = true;
    send({ type: "pause" });
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:2147483647;background:#111;color:#eee;" +
      "padding:12px 14px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);font:14px sans-serif;width:640px;max-width:90vw";
    box.innerHTML =
      '<div style="margin-bottom:6px;opacity:.8">録画を止めています。ここで入れたいテロップをメモ（Enter で確定・Esc で取り消し）</div>';
    const input = document.createElement("input");
    input.style.cssText = "width:100%;box-sizing:border-box;padding:8px;font:16px sans-serif;border-radius:6px;border:1px solid #555;background:#222;color:#fff";
    box.appendChild(input);
    const prevFocus = document.activeElement;
    document.documentElement.appendChild(box);
    input.focus();
    const close = (memo) => {
      box.remove();
      prevFocus?.focus?.();
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          setTimeout(() => {
            send({ type: "resume" });
            if (memo !== null) send({ type: "mark", memo });
            memoOpen = false;
          }, 200),
        ),
      );
    };
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        close(input.value.trim());
      } else if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    });
  };
  addEventListener(
    "keydown",
    (e) => {
      if (memoOpen) return;
      if (e.key === "F8") {
        e.preventDefault();
        openMemo();
      } else send({ type: "key" });
    },
    true,
  );
});

// 画面: screencast。届いたフレームはすぐ ack しないと次が来ない。
const cdp = await context.newCDPSession(page);
// 動きの多いページだと 100 枚/秒近く届くので、書き出しと同じ 30fps に間引いて保存する。
let n = 0;
let lastSaved = -Infinity;
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  const t = rel((metadata.timestamp ?? Date.now() / 1000) * 1000);
  if (t === null || t - lastSaved < 1000 / 30) return;
  lastSaved = t;
  const f = `${String(++n).padStart(6, "0")}.jpg`;
  fs.writeFileSync(path.join(framesDir, f), Buffer.from(data, "base64"));
  frames.push({ f, t });
});
const startCast = async () => {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await cdp
    .send("Page.startScreencast", {
      format: "jpeg",
      quality: QUALITY,
      maxWidth: Math.round(VIEW.width * DPR),
      maxHeight: Math.round(VIEW.height * DPR),
      everyNthFrame: 1,
    })
    .catch(() => {});
};
await startCast();
// 別プロセスへの遷移で止まることがあるので、遷移のたびに掛け直す。
page.on("framenavigated", (fr) => {
  if (fr === page.mainFrame()) {
    const t = rel(Date.now());
    if (t !== null) events.push({ type: "nav", t, url: fr.url().replace(/[?#].*$/, "") });
    startCast();
  }
});

await page.goto(startUrl);
console.log(`録画中: ${name}（F8 = テロップのメモ・止めている間は録画されない・終わったらブラウザを閉じる）`);
const closed = new Promise((r) => {
  context.on("close", r);
  page.on("close", r);
});
// 落ちたときの手がかり（2026-10-02、プレビュー中に 3 回続けて録画用 Chrome が消えた）。
page.on("crash", () => console.error(`[落ちた] ページがクラッシュ（${(rel(Date.now()) ?? -1) / 1000} 秒）`));
page.on("close", () => console.log(`[終了] ページが閉じた（${(rel(Date.now()) ?? -1) / 1000} 秒）`));
context.browser()?.on("disconnected", () => console.log("[終了] ブラウザとの接続が切れた"));
page.on("pageerror", (e) => console.error(`[ページのエラー] ${String(e).slice(0, 200)}`));
// 確認ダイアログ（window.confirm 等、2026-10-04）: Playwright はリスナーが無いと自動で「キャンセル」するので、
// 「復元しないで全部消す」のような確認付きのボタンが無反応に見えていた。録画では押した＝実行する意図なので OK で返す
// （ダイアログ自体は録画に映らない）。
page.on("dialog", (d) => {
  console.log(`[確認ダイアログ] ${d.type()}: ${d.message().slice(0, 120)} → OK`);
  d.accept().catch(() => {});
});
// ダウンロード（2026-10-03）: この録画用プロファイルでは、ダウンロードが始まった瞬間にブラウザごと落ちる
// （完了時の自動保存・ZIP・チェックポイントの一括 DL のたびに録画が終わっていた原因。_dltest で再現。
// 新しいプロファイルでは落ちないが、ログイン状態を持っているのでこのプロファイルを使い続ける）。
// 録画ではファイルは要らないので、ダウンロードはブラウザ側で断る（画面はそのまま・取り消されるだけ）。
const cdpDl = await context.newCDPSession(page);
await cdpDl.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch((e) =>
  console.error(`[ダウンロード] 断る設定に失敗（落ちるかもしれない）: ${String(e).slice(0, 120)}`),
);
page.on("download", (d) =>
  console.log(`[ダウンロード] ${d.suggestedFilename()} は録画中なので保存しない（${(rel(Date.now()) ?? -1) / 1000} 秒）`),
);
context.on("page", (p) => console.log(`[別タブ] ${p.url()}（${(rel(Date.now()) ?? -1) / 1000} 秒）`));
// 名前が demo のときは自動で動かして閉じる（仕組みの動作確認用。人が触らなくても一通り撮れる）。
if (name === "demo") {
  const m = page.mouse;
  const mark = async (memo) => {
    await page.keyboard.press("F8");
    await page.waitForTimeout(800);
    await page.keyboard.type(memo);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
  };
  await page.waitForTimeout(1500);
  await m.move(400, 300, { steps: 20 });
  await mark("メモの動作確認");
  await m.move(800, 120, { steps: 25 });
  await m.down();
  await m.up();
  await page.waitForTimeout(1500);
  await mark("メモの動作確認");
  for (let i = 0; i < 6; i++) {
    await m.wheel(0, 400);
    await page.waitForTimeout(300);
  }
  await m.move(1200, 600, { steps: 25 });
  await page.waitForTimeout(9000); // 早送りされる待ち
  await mark("メモの動作確認");
  await m.move(300, 700, { steps: 25 });
  await m.down();
  await m.up();
  await page.waitForTimeout(2000);
  events.push({ type: "nav", t: rel(Date.now()), url: "(demo end)" });
} else {
  await closed;
}

if (pausedAt !== null) pauses.push([pausedAt, Date.now()]), (pausedAt = null);
const end = rel(Date.now());
frames.sort((a, b) => a.t - b.t);
events.sort((a, b) => a.t - b.t);
const session = { name, view: VIEW, dpr: DPR, duration: end, frames, events };
fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(session));

// テロップの下書き。F8 の位置に空欄を置き、そのとき書いたメモを memo に残す（text を書くまで画面には出ない）。手で直す前提なので、既にあれば触らない。
const editPath = path.join(outDir, "edit.json");
if (!fs.existsSync(editPath)) {
  const captions = events
    .filter((e) => e.type === "mark")
    .map((e) => ({ at: +(e.t / 1000).toFixed(1), memo: e.memo ?? "", text: "" }));
  fs.writeFileSync(editPath, JSON.stringify({ title: "", captions }, null, 2) + "\n");
}
const clicks = events.filter((e) => e.type === "click").length;
console.log(`保存: ${path.relative(root, outDir)}（${(end / 1000).toFixed(0)} 秒・画面 ${frames.length} 枚・クリック ${clicks} 回）`);
await context.close().catch(() => {});
