import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { siteConfig } from "@/lib/data";

export const metadata: Metadata = {
  title: `特定商取引法に基づく表記 — ${siteConfig.name}`,
};

const entries: { label: string; value: string }[] = [
  { label: "販売事業者名", value: siteConfig.legalName },
  {
    label: "運営統括責任者",
    value: siteConfig.legalName,
  },
  {
    label: "所在地",
    value:
      "請求があった場合には遅滞なく開示いたします。お問い合わせフォームよりご請求ください。",
  },
  {
    label: "電話番号",
    value:
      "請求があった場合には遅滞なく開示いたします。お問い合わせフォームよりご請求ください。",
  },
  { label: "メールアドレス", value: "お問い合わせフォームよりご連絡ください。" },
  {
    label: "販売価格",
    value:
      "各商品・プランのページに表示する価格（すべて税込）によります。",
  },
  {
    label: "商品代金以外の必要料金",
    value: "インターネット接続に必要な通信費等はお客様のご負担となります。",
  },
  {
    label: "お支払い方法",
    value: "クレジットカード決済（Stripeを利用予定）",
  },
  {
    label: "お支払い時期",
    value:
      "都度チャージプランは購入手続き完了時、月額サブスクリプションプランは契約開始時および以後毎月の更新日に課金されます。",
  },
  {
    label: "サービス提供時期",
    value:
      "決済完了後、直ちにクレジットの付与、またはサブスクリプションの利用開始が行われます。",
  },
  {
    label: "返品・キャンセルについて",
    value:
      "デジタルコンテンツの性質上、購入手続き完了後の返金・キャンセルは原則としてお受けできません。サービスに重大な不具合があった場合は、お問い合わせフォームよりご連絡ください。",
  },
  {
    label: "動作環境",
    value:
      "最新版の主要ブラウザ（Google Chrome、Safari等）でのご利用を推奨します。配布ツールの動作環境は各製品ページの記載に従います。",
  },
];

export default function TokushohoPage() {
  return (
    <LegalPage
      title="特定商取引法に基づく表記"
      updatedAt="2026年8月18日"
    >
      <div className="overflow-hidden rounded-2xl border border-border">
        <dl className="divide-y divide-border">
          {entries.map((entry) => (
            <div
              key={entry.label}
              className="grid gap-1 bg-surface/40 p-5 sm:grid-cols-[10rem_1fr] sm:gap-6"
            >
              <dt className="text-xs font-medium text-muted sm:text-sm">
                {entry.label}
              </dt>
              <dd className="text-sm leading-relaxed text-foreground/80">
                {entry.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="mt-8 text-xs leading-relaxed text-muted">
        ※
        本表記における所在地・電話番号は、消費者庁の通達に基づき、個人事業主が運営するサービスとして、請求があった場合に遅滞なく開示する対応としています。
      </p>
    </LegalPage>
  );
}
