import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/LegalPage";
import { siteConfig } from "@/lib/data";

export const metadata: Metadata = {
  title: `プライバシーポリシー — ${siteConfig.name}`,
};

export default function PrivacyPage() {
  return (
    <LegalPage title="プライバシーポリシー" updatedAt="2026年8月18日">
      <LegalSection heading="1. 基本方針">
        <p>
          {siteConfig.name}（以下「当サイト」といいます）は、ユーザーの個人情報の重要性を認識し、適切に取得・利用・管理することをお約束します。本ポリシーは、当サイトが提供するサービスにおける個人情報の取り扱いについて定めるものです。
        </p>
      </LegalSection>

      <LegalSection heading="2. 取得する情報">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>お問い合わせフォームにご入力いただく氏名、メールアドレス、お問い合わせ内容</li>
          <li>ログイン（Googleアカウント連携）時に取得するメールアドレス・表示名等の基本プロフィール情報</li>
          <li>決済手続きに伴い決済代行事業者を通じて処理される取引情報（カード情報自体は当サイトでは保持しません）</li>
          <li>Studio機能のご利用状況（生成回数、クレジット消費履歴等）</li>
          <li>Cookie、アクセスログ等のサービス利用状況に関する情報</li>
        </ul>
        <p className="mt-3">
          なお、Studio機能で入力されたプロンプトおよび生成された画像データは、サーバー上に永続保存されません。生成結果はリクエスト処理の完了後に破棄される、完全プライバシー保護設計です。
        </p>
      </LegalSection>

      <LegalSection heading="3. 利用目的">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>本サービスの提供、本人確認、クレジット・サブスクリプションの管理</li>
          <li>お問い合わせへの対応・ご連絡</li>
          <li>サービスの維持、不正利用の防止、品質向上のための分析</li>
          <li>利用規約に違反する行為への対応</li>
        </ul>
      </LegalSection>

      <LegalSection heading="4. 第三者提供">
        <p>
          当サイトは、法令に基づく場合を除き、ユーザーの同意なく個人情報を第三者に提供することはありません。ただし、決済処理（Stripe等）、認証（Google等）、通知（Discord Webhook等）のために必要な範囲で、業務委託先・連携先に情報を提供する場合があります。
        </p>
      </LegalSection>

      <LegalSection heading="5. Cookie等の利用">
        <p>
          当サイトは、サービス向上のためにCookieおよび類似の技術を利用する場合があります。ブラウザの設定によりCookieを無効化することが可能ですが、その場合、一部機能がご利用いただけないことがあります。
        </p>
      </LegalSection>

      <LegalSection heading="6. 情報の管理">
        <p>
          当サイトは、取得した個人情報について、漏えい・滅失・毀損の防止その他の安全管理のために必要かつ適切な措置を講じます。
        </p>
      </LegalSection>

      <LegalSection heading="7. 開示・訂正・削除等の請求">
        <p>
          ユーザーは、当サイトが保有する自己の個人情報について、開示・訂正・削除等を請求することができます。ご希望の場合は、お問い合わせフォームよりご連絡ください。合理的な期間内に対応いたします。
        </p>
      </LegalSection>

      <LegalSection heading="8. ポリシーの変更">
        <p>
          当サイトは、必要に応じて本ポリシーの内容を変更することがあります。変更後の内容は、本ページに掲載した時点から効力を生じます。
        </p>
      </LegalSection>

      <LegalSection heading="9. お問い合わせ窓口">
        <p>
          個人情報の取り扱いに関するお問い合わせは、サイト内のお問い合わせフォームよりご連絡ください。
        </p>
      </LegalSection>
    </LegalPage>
  );
}
