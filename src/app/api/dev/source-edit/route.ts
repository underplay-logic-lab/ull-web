import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

// ローカル開発専用（next dev）。SourceTextEditor（src/components/
// SourceTextEditor.tsx）の書き込み先。ホームページビルダー的な「実際の
// 見た目のまま編集してアップロード」を、DBではなくソースファイル直接
// 書き換えで実現する——本番(Vercel)はデプロイのたびに使い捨てられる
// 読み取り専用の実行環境なので、このルート自体が意味を持たない。production
// ビルドでは常に404を返し、絶対にファイルへ触れない。
//
// 安全策1: oldText が対象ファイル内にちょうど1箇所しか無い場合のみ書き換える
// （Edit toolのold_string一意性チェックと同じ考え方）。0件は「既に変わった
// か動的な文言」、複数件は「一意に特定できない」として、どちらも書き込まず
// エラーを返す。
// 安全策2（CSRF対策）: 認証トークンを持たないPOSTルートなので、同一オリジン
// からのリクエストであることをOrigin/Refererで確認する——開発サーバーが
// 起動している間、ブラウザの別タブで開いている無関係なページから
// fetch('http://localhost:3000/api/dev/source-edit', {method:'POST', ...})
// を撃たれてソースファイルを無断改変される、という攻撃を防ぐ。
function isSameOriginRequest(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin) return false; // Origin/Refererどちらも無いクロスオリジン送信元は拒否
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "この機能は開発環境専用です。" }, { status: 404 });
  }
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "不正なリクエスト元です。" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const file = typeof body?.file === "string" ? body.file : "";
  const oldText = typeof body?.oldText === "string" ? body.oldText : "";
  const newText = typeof body?.newText === "string" ? body.newText : "";

  if (!file || !oldText || oldText === newText) {
    return NextResponse.json({ error: "不正なリクエストです。" }, { status: 400 });
  }

  // data-source-file は常に "src/..." 相対パス（各コンポーネントの自己申告
  // 文字列リテラル）。プロジェクトルート配下の src/ 以外には絶対に触れない
  // よう二重にガードする。
  const root = process.cwd();
  const srcRoot = path.join(root, "src") + path.sep;
  const abs = path.normalize(path.join(root, file));
  if (file.includes("..") || !abs.startsWith(srcRoot)) {
    return NextResponse.json({ error: "不正なファイルパスです。" }, { status: 400 });
  }

  let content: string;
  try {
    content = await fs.readFile(abs, "utf-8");
  } catch {
    return NextResponse.json({ error: "ファイルを読み込めませんでした。" }, { status: 404 });
  }

  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    return NextResponse.json(
      {
        error:
          "元の文言がファイル内に見つかりませんでした（既に変更されているか、動的に生成される文言の可能性があります）。",
      },
      { status: 409 },
    );
  }
  if (occurrences > 1) {
    return NextResponse.json(
      { error: `同じ文言がこのファイル内に${occurrences}箇所あり、一意に特定できません。Alt+クリックでエディタを開いて手動編集してください。` },
      { status: 409 },
    );
  }

  const updated = content.replace(oldText, newText);
  try {
    await fs.writeFile(abs, updated, "utf-8");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "書き込みに失敗しました。" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, file, occurrences: 1 });
}
