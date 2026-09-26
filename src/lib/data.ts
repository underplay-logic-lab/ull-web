import { POLAR_PRODUCT_IDS } from "@/lib/polarProducts";

export const siteConfig = {
  name: "UNDERPLAY LOGIC LAB",
  shortName: "UPLL",
  tagline: "AI Generation & Automation",
  description:
    "AI生成の自動化と独自ツールの配布を行う、AIクリエイター・自動化エンジニアのためのWeb拠点。",
  // Formal registered name for legal disclosures and the footer copyright line.
  legalName: "ULL (Underplay Logic Lab)",
};

// Single source of truth for the site's public-facing contact address —
// referenced by the footer, legal pages (特商法/プライバシーポリシー/利用規約),
// so it only needs updating in one place. The actual inbox the /api/contact
// form delivers to is configured separately via CONTACT_RECEIVER_EMAIL.
export const CONTACT_EMAIL = "support@ullstudio.com";

export const navLinks = [
  { label: "Studio", href: "/#studio" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Contact", href: "/#contact" },
];

export type AspectRatio = "16:9" | "9:16" | "1:1";

export const aspectRatios: { id: AspectRatio; label: string }[] = [
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
];

// Fallback only — the credits actually charged/displayed are read live from
// the studio_pricing table (see src/lib/wanAnimatePricing.ts). This value is
// used solely if that DB read fails, so generation never hard-blocks on a
// pricing-table outage.
export const WAN_ANIMATE_GENERATION_COST = 10;

// Must match the GPU actually attached to the deployed Modal endpoint (see
// gpu=... in scripts/modal_wan_animate.py) — swapping hardware there means
// updating only this object, not any component markup.
export type WanAnimateGpuSpec = {
  name: string;
  vramGb: number;
  deploymentMode: string;
};

export const WAN_ANIMATE_GPU_SPEC: WanAnimateGpuSpec = {
  name: "NVIDIA L40S",
  vramGb: 48,
  deploymentMode: "サーバーレス稼働中",
};

// ULTRA tier — must match gpu=... on WanAnimateUltra in
// scripts/modal_wan_animate.py.
export const WAN_ANIMATE_ULTRA_GPU_SPEC: WanAnimateGpuSpec = {
  name: "NVIDIA B300",
  vramGb: 288,
  deploymentMode: "サーバーレス稼働中",
};

// Fallback only — the credits actually charged/displayed are read live from
// studio_pricing.wan_animate_gpu_ultra_addon (see wanAnimatePricing.ts),
// same convention as WAN_ANIMATE_GENERATION_COST above.
export const WAN_ANIMATE_GPU_ULTRA_ADDON = 40;

export const WAN_ANIMATE_MODEL_NAME = "Wan Animate 2";
export const WAN_ANIMATE_MODEL_PARAMS = "14B";

export type PricingPlan = {
  id: string;
  // Polar product id this plan checks out through — see POLAR_PRODUCT_IDS in
  // src/lib/polarProducts.ts (synced from the live catalog, env-overridable).
  productId?: string;
  name: string;
  price: string;
  period?: string;
  description: string;
  features: string[];
  cta: string;
  highlighted?: boolean;
  /** 1 回の購入で付くクレジットと税込価格（1C あたりの比較・確認画面に使う。webhook の付与量は polar.ts が正）。 */
  credits: number;
  priceYen: number;
};

export const pricingPlans: PricingPlan[] = [
  // 2026-09-23 改定（docs/pricing-decision-sheet.md）。床は Studio の 1.66 ¥/C。
  {
    id: "topup",
    credits: 300,
    priceYen: 1000,
    productId: POLAR_PRODUCT_IDS.topup,
    name: "都度チャージ",
    price: "¥1,000",
    period: "/ 300 Credits",
    description: "必要な分だけ都度購入。サブスクリプション不要でいつでも使えます。",
    features: [
      "300クレジット付与",
      "購入日から180日間有効",
      "追加チャージは何度でも",
    ],
    cta: "購入する",
  },
  {
    id: "entry",
    credits: 800,
    priceYen: 1980,
    productId: POLAR_PRODUCT_IDS.entry,
    name: "月額エントリー",
    price: "¥1,980",
    period: "/ 月",
    description: "超解像やマルチアングルを日常的に使いたい方向けの入口プラン。",
    features: [
      "毎月800クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+10クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 10%OFFの¥900（※プラン継続特典）",
    ],
    cta: "購入する",
  },
  {
    id: "standard",
    credits: 2200,
    priceYen: 4980,
    productId: POLAR_PRODUCT_IDS.standard,
    name: "月額スタンダード",
    price: "¥4,980",
    period: "/ 月",
    description: "LoRA学習まで含めて本格的にStudioを使うクリエイター向け。",
    features: [
      "毎月2,200クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+10クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 20%OFFの¥800（※プラン継続特典）",
    ],
    cta: "購入する",
  },
  {
    id: "pro",
    credits: 5000,
    priceYen: 9980,
    productId: POLAR_PRODUCT_IDS.pro,
    name: "月額プロ",
    price: "¥9,980",
    period: "/ 月",
    description: "動画LoRAや長尺Directorも回せる、副業・小規模受託向けの上位プラン。",
    features: [
      "毎月5,000クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+10クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 30%OFFの¥700（※プラン継続特典）",
      "優先サポート対応",
    ],
    cta: "購入する",
    highlighted: true,
  },
  {
    id: "master",
    credits: 11000,
    priceYen: 19800,
    productId: POLAR_PRODUCT_IDS.master,
    name: "月額マスター",
    price: "¥19,800",
    period: "/ 月",
    description: "動画LoRAと長尺Directorを月に複数本こなす制作者向け。",
    features: [
      "毎月11,000クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+10クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 40%OFFの¥600（※プラン継続特典）",
      "優先サポート対応",
    ],
    cta: "購入する",
  },
  {
    id: "studio",
    credits: 18000,
    priceYen: 29800,
    productId: POLAR_PRODUCT_IDS.studio,
    name: "月額スタジオ",
    price: "¥29,800",
    period: "/ 月",
    description: "受託・チーム制作向けの最上位プラン。1クレジットあたりの単価が最も安くなります。",
    features: [
      "毎月18,000クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+10クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 50%OFFの¥500（※プラン継続特典）",
      "最優先VIPサポート対応",
    ],
    cta: "購入する",
  },
];

export type Article = {
  id: string;
  title: string;
  excerpt: string;
  category: string;
  date: string;
  url: string;
  readTime: string;
};

export const articles: Article[] = [
  {
    id: "parallel-download-architecture",
    title: "大容量AIモデルの並列ダウンロード設計 — 4並列で最速化する方法",
    excerpt:
      "HTTP Range Request とワーカープールを組み合わせた、堅牢かつ高速なダウンロードアーキテクチャの解説。",
    category: "Architecture",
    date: "2026-02-28",
    url: "https://note.com/underplay/n/example1",
    readTime: "12 min",
  },
  {
    id: "comfyui-vram-optimization",
    title: "ComfyUI VRAM最適化完全ガイド — 24GB未満でもFluxを回す",
    excerpt:
      "Attention Slicing、モデルオフロード、LoRAキャッシュ戦略を体系的に解説。実測ベンチマーク付き。",
    category: "Tutorial",
    date: "2026-02-15",
    url: "https://note.com/underplay/n/example2",
    readTime: "18 min",
  },
  {
    id: "ai-workflow-automation",
    title: "AIワークフロー自動化の設計パターン — Cursor × MCP × 自作ツール",
    excerpt:
      "エージェント型開発環境とカスタムMCPサーバーを組み合わせた、再現性の高い自動化パイプライン構築法。",
    category: "Workflow",
    date: "2026-01-30",
    url: "https://note.com/underplay/n/example3",
    readTime: "15 min",
  },
  {
    id: "lora-training-pipeline",
    title: "LoRA学習パイプラインの完全自動化 — データ前処理からデプロイまで",
    excerpt:
      "kohya_ss + ComfyUI + 自作バリデーションノードによる、エンドツーエンドのLoRA開発フロー。",
    category: "Deep Dive",
    date: "2026-01-12",
    url: "https://note.com/underplay/n/example4",
    readTime: "22 min",
  },
];

export const contactServices = [
  "決済・アカウントに関するご質問",
  "システムの不具合・バグ報告",
  "大口利用・エンタープライズプランのご相談",
  "リクエスト・その他サポート",
];
