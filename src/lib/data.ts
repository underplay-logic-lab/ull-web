export const siteConfig = {
  name: "UNDERPLAY LOGIC LAB",
  shortName: "UPLL",
  tagline: "AI Generation & Automation",
  description:
    "AI生成の自動化と独自ツールの配布を行う、AIクリエイター・自動化エンジニアのためのWeb拠点。",
  // Formal registered name for legal disclosures and the footer copyright line.
  legalName: "ULL (Underplay Logic Lab)",
};

export const navLinks = [
  { label: "Studio", href: "/#studio" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Products", href: "/#products" },
  { label: "Contact", href: "/#contact" },
];

export type AspectRatio = "16:9" | "9:16" | "1:1";

export const aspectRatios: { id: AspectRatio; label: string }[] = [
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
];

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

export const WAN_ANIMATE_MODEL_NAME = "Wan Animate 2";
export const WAN_ANIMATE_MODEL_PARAMS = "14B";

export type WanAnimateMotionPreset = {
  id: string;
  label: string;
  description: string;
  videoUrl: string;
};

export const wanAnimateMotionPresets: WanAnimateMotionPreset[] = [
  {
    id: "street-dance",
    label: "ストリートダンス",
    description: "テンポの良いフリースタイルダンス",
    videoUrl: "/mock/wan-animate/preset-street-dance.mp4",
  },
  {
    id: "runway",
    label: "ランウェイ",
    description: "モデルウォークで魅せるファッションポーズ",
    videoUrl: "/mock/wan-animate/preset-runway.mp4",
  },
  {
    id: "action",
    label: "アクション",
    description: "躍動感あるアクションムーブ",
    videoUrl: "/mock/wan-animate/preset-action.mp4",
  },
];

export type Product = {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  quickBadges: string[];
  features: string[];
  downloadUrl?: string;
  badge?: string;
  note?: string;
};

export const products: Product[] = [
  {
    id: "model-downloader",
    name: "Underplay High-Speed Model Downloader",
    version: "v2.1",
    tagline: "大容量モデルを最速でローカルへ",
    description:
      "Civitai / Hugging Face など複数ソースからのマルチスレッド並列ダウンロード、自動仕分け、高速マージを一体化。AI開発環境のセットアップ時間を劇的に短縮します。",
    quickBadges: ["並列DL", "自動仕分け", "高速マージ"],
    features: [
      "Civitai / Hugging Face等のモデル・LoRA・素材を一括ダウンロード",
      "マルチスレッド並列処理による超高速ダウンロード",
      "フォルダ階層の自動正規化配置",
    ],
    downloadUrl: "/downloads/underplay_dl_manager.zip",
    badge: "無料配布",
    note: "※本ツールは Windows 10 / 11 専用です（ZIPを解凍後、exeをダブルクリックで即起動・インストール不要）",
  },
];

export type PricingPlan = {
  id: string;
  name: string;
  price: string;
  period?: string;
  description: string;
  features: string[];
  cta: string;
  highlighted?: boolean;
};

export const pricingPlans: PricingPlan[] = [
  {
    id: "topup",
    name: "都度チャージ",
    price: "¥500",
    period: "/ 120 Credits",
    description: "必要な分だけ都度購入。サブスクリプション不要でいつでも使えます。",
    features: [
      "120クレジット付与",
      "購入日から180日間有効",
      "追加チャージは何度でも",
    ],
    cta: "購入する",
  },
  {
    id: "entry",
    name: "月額エントリー",
    price: "¥980",
    period: "/ 月",
    description: "毎日少しずつStudioを使いたい方向けの月額プラン。",
    features: [
      "毎月300クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+4クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 10%OFFの¥450（※プラン継続特典）",
    ],
    cta: "購入する",
  },
  {
    id: "standard",
    name: "月額スタンダード",
    price: "¥2,480",
    period: "/ 月",
    description: "本格的にStudioを使い倒すクリエイター向けのプラン。",
    features: [
      "毎月1,000クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+8クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 20%OFFの¥400（※プラン継続特典）",
    ],
    cta: "購入する",
  },
  {
    id: "pro",
    name: "月額プロ",
    price: "¥4,980",
    period: "/ 月",
    description: "受託案件・大量生成にも対応する上位プラン。",
    features: [
      "毎月2,500クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+15クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 30%OFFの¥350（※プラン継続特典）",
      "優先サポート対応",
    ],
    cta: "購入する",
    highlighted: true,
  },
  {
    id: "master",
    name: "月額マスター",
    price: "¥9,980",
    period: "/ 月",
    description: "チーム利用・大規模制作向けの最上位プラン。",
    features: [
      "毎月6,000クレジットを自動付与",
      "デイリーログインボーナス（1日1回）で毎日+30クレジット（※プラン継続特典）",
      "会員限定・追加チャージ優待 50%OFFの¥250（※プラン継続特典）",
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
  "特注ワークフロー・モデル追加のリクエスト",
  "ローカル / クラウド環境構築（遠隔リモート対応可能）",
  "業務特化型AIワークフローの設計・導入支援",
  "その他のお問い合わせ",
];
