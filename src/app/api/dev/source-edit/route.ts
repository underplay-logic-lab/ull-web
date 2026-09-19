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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// JSXは、テキスト内の改行+インデントを表示上は空白1つに潰す（HTMLの空白折り
// 畳みと同じ）。そのためブラウザから届く oldText（el.textContent。単一空白）
// は、複数行にまたがって書かれたソースの生テキスト（実際の改行+インデント）
// とバイト単位では一致しない——単純な文字列一致だとこのケースだけ「見つから
// ない」誤検知になる。oldText内の空白ランをすべて「任意の空白ランにマッチする
// \s+」に緩めた正規表現で探すことで、複数行ソースでも正しく1箇所に特定できる
// ようにする（空白以外は引き続き完全一致——安全性は変えない）。
// 短いテキスト（例:「秒単位」）が、同じファイル内の別の文字列（コメントや
// 別のEditableTextのfallback文言等）の「部分文字列」として偶然出現し、
// 無関係の箇所まで1箇所としてカウントされてしまうケースがある（実例:
// Hero.tsx内の統計値「秒単位」が、同ファイルのバッジ文言fallback「...
// クラウドの手軽さ × 秒単位の適正価格」の一部にもマッチしてしまう）。
// 前後が「文字・数字（Unicode全般。漢字・かな・カナ含む）」で連続していない
// ——つまり引用符・JSXタグ境界・空白・句読点など、独立した語/文字列の
// 境界になっている——場合だけを候補にすることで、単語の途中への誤爆を防ぐ。
function buildLooseWhitespaceRegex(oldText: string): RegExp {
  const parts = oldText.split(/(\s+)/);
  const pattern = parts.map((part) => (/^\s+$/.test(part) ? "\\s+" : escapeRegExp(part))).join("");
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "gu");
}

// data-source-file が指すのは「クリックした要素を囲むJSXがあるファイル」
// だが、表示文字列自体は src/lib/data.ts のような共有定数ファイルで定義され
// .map() で展開されているだけ、というケースがある（例: Contact.tsx の
// お問い合わせ用途リストは実体が src/lib/data.ts の contactServices 配列）。
// ヒント先のファイルで見つからなかった場合、src/ 配下の .ts/.tsx 全体から
// 一意に特定できるファイルを探すフォールバック。一意性の担保は「1ファイル
// 内で1箇所」から「src/全体で1箇所」に強まるだけなので安全性は変わらない。
async function walkSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkSourceFiles(full)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

async function findUniqueMatchAcrossSrc(
  srcRoot: string,
  regex: RegExp,
): Promise<{ file: string; totalMatches: number; fileCount: number } | null> {
  const files = await walkSourceFiles(srcRoot.slice(0, -1));
  let totalMatches = 0;
  const hitFiles: string[] = [];
  for (const f of files) {
    let c: string;
    try {
      c = await fs.readFile(f, "utf-8");
    } catch {
      continue;
    }
    const m = c.match(regex) ?? [];
    if (m.length > 0) {
      totalMatches += m.length;
      hitFiles.push(f);
    }
  }
  if (hitFiles.length !== 1) return { file: "", totalMatches, fileCount: hitFiles.length };
  return { file: hitFiles[0], totalMatches, fileCount: 1 };
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

  const regex = buildLooseWhitespaceRegex(oldText);
  let targetAbs = abs;
  let targetContent = content;
  const primaryMatches = content.match(regex) ?? [];

  if (primaryMatches.length > 1) {
    return NextResponse.json(
      { error: `同じ文言がこのファイル内に${primaryMatches.length}箇所あり、一意に特定できません。Alt+クリックでエディタを開いて手動編集してください。` },
      { status: 409 },
    );
  }

  if (primaryMatches.length === 0) {
    // ヒント先ファイルに無かった — src/lib/data.ts のような共有定数ファイル
    // にある可能性を探る。
    const fallback = await findUniqueMatchAcrossSrc(srcRoot, regex);
    if (!fallback || fallback.fileCount === 0) {
      return NextResponse.json(
        {
          error:
            "元の文言がファイル内に見つかりませんでした（既に変更されているか、動的に生成される文言の可能性があります）。",
        },
        { status: 409 },
      );
    }
    if (fallback.fileCount > 1 || fallback.totalMatches > 1) {
      return NextResponse.json(
        {
          error: `同じ文言が複数のファイルにまたがって存在し、一意に特定できません。Alt+クリックでエディタを開いて手動編集してください。`,
        },
        { status: 409 },
      );
    }
    targetAbs = fallback.file;
    try {
      targetContent = await fs.readFile(targetAbs, "utf-8");
    } catch {
      return NextResponse.json({ error: "ファイルを読み込めませんでした。" }, { status: 404 });
    }
  }

  const updated = targetContent.replace(regex, () => newText);
  try {
    await fs.writeFile(targetAbs, updated, "utf-8");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "書き込みに失敗しました。" },
      { status: 500 },
    );
  }

  const actualFile = path.relative(root, targetAbs).replace(/\\/g, "/");
  return NextResponse.json({ ok: true, file: actualFile, occurrences: 1 });
}
