import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// よくある質問（2026-09-26、ローンチ準備。メモリ launch-checklist-ai-seo）。本文と FAQPage の JSON-LD を同じ配列から
// 出すので、書き換えはここだけでよい。基盤モデル名・GPU 型番は書かない（CLAUDE.md §2。LoRA のベースモデル名だけは例外）。
// LoRA の「うまく出ないときは」は完了画面（LoraStudioTab.tsx）と同じ 5 項目。実案件・実測で確かめたことだけを書く。

export const metadata: Metadata = {
  title: "よくある質問 — ULL Studio",
  description: "ULL Studio の使い方・料金・データの扱い・LoRA 学習についてのよくある質問です。",
};

type Faq = { q: string; a: string };

const SECTIONS: { title: string; items: Faq[] }[] = [
  {
    title: "サービス全般",
    items: [
      {
        q: "ULL Studio で何ができますか？",
        a: "参照画像から映像を作る Cinematic Director（動画生成）、1 枚の画像から別アングルを作るマルチアングル、画像の 4K/8K 超解像、動画の 4K 超解像、自分の画像で LoRA を学習する LoRA Studio の 5 つです。",
      },
      {
        q: "高性能な PC は必要ですか？",
        a: "必要ありません。生成と学習はすべてサーバー側の GPU で行うので、スマホや安価なノート PC のブラウザから使えます。最新版の主要ブラウザ（Google Chrome、Safari、Edge 等）を推奨します。",
      },
      {
        q: "実行中に次の生成を出せますか？",
        a: "出せます。今の処理が終わってから順番に実行する「順番待ち」は追加料金なしです。待たずに並列で実行する場合は追加料金がかかります。LoRA 学習は順番待ちが無く、学習中にもう 1 本出す場合は追加料金がかかります（終わってから出せば通常料金です）。",
      },
    ],
  },
  {
    title: "料金・クレジット",
    items: [
      {
        q: "料金のしくみは？",
        a: "各機能で使った分だけクレジットを消費します。クレジットは都度チャージ（¥1,000 / 300 クレジット）か、毎月クレジットが付与される月額プランで購入できます。機能ごとの消費量の目安は「料金の目安」ページにあり、実際の消費量は各機能の画面で実行前に表示されます。",
      },
      {
        q: "考えている間や待っている間も料金はかかりますか？",
        a: "かかりません。消費するのは生成・学習の処理に使った分だけです。",
      },
      {
        q: "生成や学習に失敗したらクレジットはどうなりますか？",
        a: "システム側の不具合や実行時間の上限で処理が完了しなかった場合は、完了しなかった分のクレジットを返金します。",
      },
      {
        q: "無料で試せますか？",
        a: "新規アカウント登録で 10 クレジットを無料で差し上げています（クレジットカードの登録は不要です）。",
      },
      {
        q: "月額プランを解約するとどうなりますか？",
        a: "解約を予約した時点でデイリーログインボーナスの付与が止まります。すでに持っているクレジットは有効期限まで使えます。",
      },
    ],
  },
  {
    title: "データ・権利",
    items: [
      {
        q: "生成した画像・動画や学習した LoRA はいつまで保存されますか？",
        a: "生成または登録から 14 日間保存した後、自動的に削除されます。削除後は復元できないので、必要なものは期間内にダウンロードしてください。",
      },
      {
        q: "生成物は商用利用できますか？",
        a: "生成物の権利はユーザーに帰属します。ただし、商用利用の可否は生成に使ったモデル・LoRA のライセンスに従います。Illustrious 系のベースモデルで学習した LoRA は Fair AI Public License 1.0-SD の条件で提供されます。詳しくは利用規約をご覧ください。",
      },
      {
        q: "どんな内容でも生成できますか？",
        a: "一般的なクラウド AI より幅広い表現に対応していますが、児童を性的に描写するもの、実在の人物の同意の無い性的な表現、第三者の権利を侵害するものなど、利用規約の禁止事項にあたる生成はできません。",
      },
    ],
  },
  {
    title: "LoRA Studio",
    items: [
      {
        q: "どのモデル向けの LoRA を作れますか？",
        a: "動画向けの Minimax H3 と、イラスト向けの WAI Illustrious です。ほかのモデルはご要望に応じて追加していきます。",
      },
      {
        q: "画像は何枚必要ですか？",
        a: "人物 1 人につき 15 枚以上をおすすめします。取り込むと構図の偏り（顔のアップばかり等）を診断し、足りない構図の切り出しや学習回数の調整を画面上で行えます。",
      },
      {
        q: "キャプション（画像の説明文）は自分で書く必要がありますか？",
        a: "AI に作らせる（有料）か、自分で書く（無料）かを選べます。どちらも学習前に確認・修正できます。",
      },
      {
        q: "学習した LoRA で人物がうまく出ません。",
        a: "まずプロンプトにトリガーワード（LoRA の名前）が入っているか確かめてください。顔・髪型などの特徴はトリガーワードに覚えさせているので、名前が無いと LoRA を強くしても別人が出ます。複数人の LoRA は全員の名前を入れます。次に、最終版より途中の保存（チェックポイント）を見比べてください。実案件では 3,000 step 中 1,750 step が最良でした。男性が女性っぽくなるときは、ネガティブプロンプトの「ugly」「醜い」を外してください。男女ペアで男性だけ似ないときは、男性の画像の学習回数を上げて学習し直すと改善します。",
      },
      {
        q: "途中の学習結果も使えますか？",
        a: "使えます。学習の途中で保存したチェックポイントを 1 つずつダウンロードできます。",
      },
    ],
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: SECTIONS.flatMap((s) =>
    s.items.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  ),
};

export default function FaqPage() {
  return (
    <div className="relative py-32">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />
      <div className="mx-auto max-w-3xl px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-neon-pink"
        >
          <ArrowLeft size={16} />
          Back to Home
        </Link>

        <h1 className="mt-8 text-3xl font-bold tracking-tight sm:text-4xl">よくある質問</h1>
        <p className="mt-4 text-sm leading-relaxed text-foreground/80">
          機能ごとの消費クレジットは{" "}
          <Link href="/pricing" className="text-neon-pink hover:underline">
            料金の目安
          </Link>
          、細かな条件は{" "}
          <Link href="/terms" className="text-neon-pink hover:underline">
            利用規約
          </Link>{" "}
          をご覧ください。
        </p>

        <div className="mt-12 space-y-10">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h2 className="text-lg font-bold text-foreground">{s.title}</h2>
              <div className="mt-3 space-y-2">
                {s.items.map((f) => (
                  <details key={f.q} className="rounded-xl border border-border bg-surface/30 px-4 py-3">
                    <summary className="cursor-pointer text-sm font-medium text-foreground">{f.q}</summary>
                    <p className="mt-2 text-sm leading-relaxed text-foreground/80">{f.a}</p>
                  </details>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
