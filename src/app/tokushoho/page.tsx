import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LegalPage } from "@/components/LegalPage";
import { siteConfig } from "@/lib/data";

export const metadata: Metadata = {
  title: `特定商取引法に基づく表記 — ${siteConfig.name}`,
};

// Support inbox for this legal notice specifically — kept as a literal here
// rather than reusing CONTACT_EMAIL (src/lib/data.ts, "contact@ullstudio.com")
// since Polar.sh's Merchant-of-Record model means this page's contact point
// is scoped to platform/billing support, not the general inbox.
const SUPPORT_EMAIL = "support@ullstudio.com";

type LegalEntry = { label: string; value: ReactNode };

const entries: LegalEntry[] = [
  {
    label: "販売事業者（Merchant of Record）",
    value: (
      <>
        Polar Software Inc.
        <br />
        <span className="mt-1 block text-xs text-muted">
          ※
          当プラットフォームにおける有料クレジットの販売、決済処理、請求、および海外付加価値税（VAT）等の税務処理は、すべて販売代行業者（Merchant
          of Record）である Polar Software Inc. を通じて行われます。
        </span>
      </>
    ),
  },
  {
    label: "運営プラットフォーム",
    value: "ULL Studio（運営：Underplay Logic Lab）",
  },
  {
    label: "販売事業者の所在地・連絡先",
    value: (
      <>
        Polar Software Inc. 公式所在地
        <br />
        <span className="mt-1 block text-xs text-muted">
          （詳細な所在地および事業者情報は Polar.sh 利用規約をご確認ください）
        </span>
      </>
    ),
  },
  {
    label: "プラットフォームお問い合わせ窓口",
    value: (
      <>
        メールアドレス：{SUPPORT_EMAIL}
        <br />
        <span className="mt-1 block text-xs text-muted">
          （※
          システムの不具合、決済トラブル、法人大口利用に関するお問い合わせを受け付けております。独自最適化エンジンの内部構造や使用モデルに関するお問い合わせには回答いたしかねます）
        </span>
      </>
    ),
  },
  {
    label: "販売価格",
    value: "各商品・クレジット購入画面に表示する価格（すべて税込/USD表記）によります。",
  },
  {
    label: "商品代金以外の必要料金",
    value: "インターネット接続に必要な通信費等はお客様のご負担となります。",
  },
  {
    label: "お支払い方法",
    value: "クレジットカード決済（Visa, Mastercard, American Express, JCB等）、Apple Pay、Google Pay（Polar.sh経由）",
  },
  {
    label: "お支払い時期",
    value: "購入手続き完了時に即時決済されます。",
  },
  {
    label: "サービス提供時期",
    value: "決済完了後、直ちにお客様のアカウントにデジタルクレジットが付与されます。",
  },
  {
    label: "返品・キャンセルについて",
    value: (
      <>
        デジタルクレジットの性質上、購入手続き完了後の返金・キャンセルは原則としてお受けできません。システムエラー等の重大な不具合によりクレジットが正常に消費された場合は、お問い合わせ窓口（{SUPPORT_EMAIL}）までご連絡ください。事実確認の上、クレジットの再付与等の対応を行います。
      </>
    ),
  },
  {
    label: "動作環境",
    value: "最新版の主要ブラウザ（Google Chrome、Safari、Edge等）でのご利用を推奨します。",
  },
];

export default function TokushohoPage() {
  return (
    <LegalPage title="特定商取引法に基づく表記" updatedAt="2026年8月26日">
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
    </LegalPage>
  );
}
