import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/LegalPage";
import { siteConfig } from "@/lib/data";

export const metadata: Metadata = {
  title: `利用規約 — ${siteConfig.name}`,
};

export default function TermsPage() {
  return (
    <LegalPage title="利用規約" updatedAt="2026年8月18日">
      <LegalSection heading="第1条（適用）">
        <p>
          本規約は、{siteConfig.name}（以下「当サイト」といいます）が提供するAI生成サービス「Studio」、ツール配布、および関連コンテンツ（以下「本サービス」といいます）の利用条件を定めるものです。ユーザーは本サービスを利用することで、本規約に同意したものとみなされます。
        </p>
      </LegalSection>

      <LegalSection heading="第2条（クレジット・課金）">
        <p>
          本サービスの一部機能は、都度チャージ制のクレジットまたは月額サブスクリプションプランにより提供されます。購入したクレジット・サブスクリプションの有効期限、利用条件は各プランの表示に従います。
        </p>
        <p>
          決済処理は外部決済代行事業者（Stripe等）を通じて行われます。購入手続きが完了した後のクレジットの返金は、法令に定める場合を除き、原則として行いません。
        </p>
      </LegalSection>

      <LegalSection heading="第3条（生成物の取り扱い）">
        <p>
          Studio機能を通じてユーザーが生成したコンテンツ（以下「生成物」）の利用可否は、契約中のプランの規定に従います。生成物の権利関係、および第三者の権利を侵害しないことについては、ユーザー自身の責任において確認してください。
        </p>
      </LegalSection>

      <LegalSection heading="第4条（禁止事項）">
        <p>ユーザーは、本サービスの利用にあたり、以下の行為をしてはなりません。</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>法令または公序良俗に違反する行為</li>
          <li>第三者の知的財産権、肖像権、プライバシー等を侵害する行為</li>
          <li>本サービスの運営を妨害する行為、または不正アクセスを試みる行為</li>
          <li>配布ツールを改変・再配布し、不正な目的で利用する行為</li>
          <li>その他、当サイトが不適切と判断する行為</li>
        </ul>
      </LegalSection>

      <LegalSection heading="第5条（配布ツールの利用）">
        <p>
          当サイトで配布するツール類は、現状有姿（AS IS）で提供されます。ツールの利用によって生じたいかなる損害についても、当サイトは責任を負いません。ツールの利用は自己責任にてお願いいたします。
        </p>
      </LegalSection>

      <LegalSection heading="第6条（免責事項）">
        <p>
          当サイトは、本サービスに事実上または法律上の瑕疵がないことを保証するものではありません。本サービスの中断・停止・終了、データの消失等によりユーザーに生じた損害について、当サイトの故意または重過失による場合を除き、責任を負いません。
        </p>
      </LegalSection>

      <LegalSection heading="第7条（規約の変更）">
        <p>
          当サイトは、必要と判断した場合、ユーザーへの事前通知なく本規約を変更できるものとします。変更後の規約は、本ページに掲載した時点から効力を生じます。
        </p>
      </LegalSection>

      <LegalSection heading="第8条（お問い合わせ）">
        <p>
          本規約に関するお問い合わせは、サイト内のお問い合わせフォームよりご連絡ください。
        </p>
      </LegalSection>
    </LegalPage>
  );
}
