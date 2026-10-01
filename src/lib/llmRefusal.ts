// LLM の「文章での」断りの検知（2026-10-01）。
//
// Gemini は安全フィルター（空応答・例外）ではなく、"I cannot fulfill this request..." のように文章で断ることがある。
// それが正常な応答として扱われ、Director では断り文がそのまま動画の指示になって課金された（ジョブ 05627a3b・0001c776）。
// LoRA Studio でも、日本語キャプションの英訳やキャプション指示の作成で同じことが起きると、断り文が学習データに入る。
// geminiText.ts の共通処理がこれで応答を調べ、断り文なら安全ブロックと同じエラーにする（各所の既存の代替経路に乗る）。
//
// 生成物（描写文・タグ列・JSON）の冒頭が一人称の断り文になることは通常ないので、冒頭 200 文字だけを見る。

const REFUSAL_HEAD_RE =
  /^\s*(?:i['’]?m sorry|i am sorry|sorry,|i can(?:no|['’])t|i (?:am|['’]m) (?:unable|not able)|i will not|i won['’]t|as an ai|unfortunately,? i|申し訳|このリクエストには|お応えできません|ご要望には)/i;
const REFUSAL_PHRASE_RE =
  /\b(?:cannot|can['’]t|unable to|not able to) (?:fulfill|comply with|help with|assist with|create|generate|produce)\b/i;

export function looksLikeRefusal(text: string): boolean {
  const head = text.trim().slice(0, 200);
  return REFUSAL_HEAD_RE.test(head) || REFUSAL_PHRASE_RE.test(head);
}
