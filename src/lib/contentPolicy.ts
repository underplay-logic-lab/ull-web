// レッドライン・コンテンツフィルター（軽量ブラックリスト方式）
//
// 目的: Polar/Stripe の利用規約（AUP）に明確に違反する違法・重大規約違反
// コンテンツ（児童の性的搾取、実在人物への性的暴行の賛美、獣姦等）の生成を
// API 入り口で機械的に拒否し、「プラットフォームとして規約遵守の対策を
// 行っている」という監査可能な証跡（ブロックログ）を残す。
//
// 設計方針:
// - 「未成年を示唆する語」単体・「性的表現を示唆する語」単体では誤爆
//   （水着・戦闘シーン等の正当な創作表現の遮断）が起きやすいため、
//   CSAM / 非同意性的表現の2カテゴリは「両方のリストに同時にヒットした
//   場合のみブロック」という組み合わせ判定にしている。単語単体で見れば
//   普通の創作でも使う語（「子供」「強要」等）を含むが、組み合わせが
//   揃わない限り誤爆しない。
// - 獣姦等、組み合わせを取るまでもなく単体で明確にアウトな語だけは
//   フラットな単独ブロックにしている。
// - 一般的な暴力・戦闘描写（このサイトの正当なユースケース）は意図的に
//   対象外。「実在の暴行・惨殺を賛美する」ような明確な語のみ対象。
// - これは最初の防衛線であり完全な検知ではない（テキストプロンプトのみが
//   対象で、Multi-Angle/LoRA の参照画像・学習画像そのものは検査できない）。
//   継続的な語彙のチューニングが前提。

export type ContentPolicyCategory =
  | "csam"
  | "bestiality"
  | "non_consensual"
  | "extreme_violence";

export type ContentPolicyResult = {
  blocked: boolean;
  category?: ContentPolicyCategory;
};

function normalize(text: string): string {
  return text.toLowerCase();
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

// --- 未成年を示唆する語（英語・日本語） -------------------------------------
const MINOR_INDICATORS: readonly string[] = [
  "child", "children", "kid", "kids", "toddler", "infant", "preteen",
  "underage", "minor", "little girl", "little boy",
  "elementary school", "middle schooler", "grade schooler",
  "loli", "lolita", "shota", "jk", "jc", "js",
  "幼女", "幼児", "児童", "未成年", "小学生", "中学生", "園児",
  "ロリ", "ショタ", "赤ちゃん", "赤ん坊",
];

// --- 性的表現を示唆する語（英語・日本語） -----------------------------------
const EXPLICIT_SEXUAL_INDICATORS: readonly string[] = [
  "nude", "naked", "sex", "sexual", "porn", "pornographic",
  "genitals", "penis", "vagina", "nipple", "nipples",
  "hentai", "nsfw", "erotic", "explicit",
  "裸", "全裸", "ヌード", "性行為", "セックス", "エロ", "陰部", "局部",
  "乳首", "性器", "わいせつ", "猥褻",
];

// --- 非同意・強制を示唆する語（英語・日本語） -------------------------------
const NON_CONSENSUAL_INDICATORS: readonly string[] = [
  "rape", "raping", "non-consensual", "nonconsensual", "unwilling",
  "forced sex", "against her will", "against his will",
  "強姦", "レイプ", "無理やり", "輪姦",
];

// --- 単体で明確にアウトな語（組み合わせ判定不要） ---------------------------
const FLAT_BLOCK_TERMS: readonly { term: string; category: ContentPolicyCategory }[] = [
  { term: "child porn", category: "csam" },
  { term: "childporn", category: "csam" },
  { term: "kiddie porn", category: "csam" },
  { term: "児童ポルノ", category: "csam" },
  { term: "ロリポルノ", category: "csam" },
  { term: "bestiality", category: "bestiality" },
  { term: "zoophilia", category: "bestiality" },
  { term: "獣姦", category: "bestiality" },
  { term: "snuff film", category: "extreme_violence" },
  { term: "necrophilia", category: "extreme_violence" },
];

// 未成年を示唆する明示的な年齢表記（0〜17歳）。単語リストだけだと
// 「8歳の女の子」のように具体的な年齢数字で書かれた場合に漏れるため、
// 別途パターンで検出する（英語「8 years old」「8yo」「age 8」、日本語「8歳」）。
const MINOR_AGE_RE =
  /\b([0-9]|1[0-7])\s*(?:-|\s)?\s*(?:years?[\s-]?old|y\.?o\.?)\b|\b(?:age[d]?\s*)([0-9]|1[0-7])\b|\b([0-9]{1,2})\s*歳/;

function hasMinorAgePattern(t: string): boolean {
  const m = MINOR_AGE_RE.exec(t);
  if (!m) return false;
  const n = Number(m[1] ?? m[2] ?? m[3]);
  return Number.isFinite(n) && n >= 0 && n <= 17;
}

/**
 * テキスト1件をポリシー判定する。ブロック対象でなければ blocked:false。
 */
export function evaluateContentPolicy(text: string | null | undefined): ContentPolicyResult {
  if (!text) return { blocked: false };
  const t = normalize(text);

  for (const { term, category } of FLAT_BLOCK_TERMS) {
    if (t.includes(term)) return { blocked: true, category };
  }

  const hasMinor = includesAny(t, MINOR_INDICATORS) || hasMinorAgePattern(t);
  const hasExplicit = includesAny(t, EXPLICIT_SEXUAL_INDICATORS);
  if (hasMinor && hasExplicit) return { blocked: true, category: "csam" };

  const hasNonConsensual = includesAny(t, NON_CONSENSUAL_INDICATORS);
  if (hasNonConsensual && hasExplicit) return { blocked: true, category: "non_consensual" };

  return { blocked: false };
}

/**
 * 複数のテキストフィールドをまとめて判定する（カスタムワークフローの
 * 複数テキストフィールド、LoRA の captions[] 等）。最初にヒットしたものを返す。
 */
export function evaluateContentPolicyMany(
  texts: readonly (string | null | undefined)[],
): ContentPolicyResult {
  for (const t of texts) {
    const r = evaluateContentPolicy(t);
    if (r.blocked) return r;
  }
  return { blocked: false };
}

export const CONTENT_POLICY_BLOCK_MESSAGE =
  "この内容は生成できません。入力内容に利用規約に違反する可能性のある表現が含まれています。";

/**
 * ブロック発生時の監査ログ。生の該当テキストは残さず、どの経路・カテゴリで
 * 誰（分かる場合）がブロックされたかだけを記録する（規約遵守の証跡）。
 */
export function logContentPolicyBlock(
  route: string,
  result: ContentPolicyResult,
  userId?: string | null,
): void {
  console.error(
    `[content-policy] blocked route=${route} category=${result.category ?? "unknown"} ` +
      `user=${userId ?? "anon"} at=${new Date().toISOString()}`,
  );
}
