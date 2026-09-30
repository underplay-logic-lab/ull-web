import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "特定商取引法に基づく表記 — ULL Studio",
};

// Kept as its own literal (matches CONTACT_EMAIL in src/lib/data.ts, both
// now "support@ullstudio.com" since the contact address was unified) rather
// than importing CONTACT_EMAIL, so this page's Merchant-of-Record contact
// point stays independently pinned if the general inbox ever changes again.
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
    value: "各商品・クレジット購入画面に表示する価格（日本円表記。日本国内のお客様は税込）によります。",
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
    value:
      "都度チャージは、購入手続き完了時に即時決済されます。月額プランは、購入手続き完了時に初回分が決済され、以降は毎月の更新日（初回購入日と同じ日付）に自動で決済されます。",
  },
  {
    label: "サービス提供時期",
    value:
      "決済完了後、直ちにお客様のアカウントにデジタルクレジットが付与されます。月額プランは、毎月の更新の決済が完了するたびに、そのプランのクレジットが付与されます。",
  },
  // 2026-10-01 ローンチ前点検で追加: 月額プラン（定期購入）の自動更新・解約の条件を明示する。
  {
    label: "月額プラン（定期購入）の自動更新・解約",
    value: (
      <>
        月額プランは、解約されるまで 1 か月ごとに自動で更新されます。解約は、ログイン後に料金欄の「プランの管理」からいつでも行えます。
        解約すると次回の更新日以降の決済は行われず、解約後も現在の期間の終わりまでは会員特典をご利用いただけます。
        期間の途中で解約された場合の日割りでの返金は行っておりません。別のプランへの変更は、料金欄から新しいプランを購入すると、
        その時点で切り替わります（それまでのプランはその時点で終了します）。
      </>
    ),
  },
  {
    label: "クレジットの有効期限",
    value: "購入・付与したクレジットの有効期限は、最後にクレジットを購入または付与された日から 180 日間です。期限を過ぎたクレジットは失効します。",
  },
  {
    label: "返品・キャンセルについて",
    value: (
      <>
        デジタルクレジットの性質上、購入手続き完了後の返金・キャンセルは原則としてお受けできません。システムエラー等の重大な不具合により、生成物が得られないままクレジットが消費された場合は、お問い合わせ窓口（{SUPPORT_EMAIL}）までご連絡ください。事実確認の上、クレジットの再付与等の対応を行います。
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
    <LegalPage title="特定商取引法に基づく表記" updatedAt="2026年10月1日">
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
