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
  { label: "Products", href: "/#products" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Contact", href: "/#contact" },
];

export type AspectRatio = "16:9" | "9:16" | "1:1";

export const aspectRatios: { id: AspectRatio; label: string }[] = [
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" },
  { id: "1:1", label: "1:1" },
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
      "マルチスレッド高速並列ダウンロード対応",
      "拡張子・種別ごとの自動フォルダ仕分け",
      "二重階層パス自動防止",
      "分割ダウンロードの高速マージ処理",
      "中断・再開（レジューム）対応",
      "SHA256 / ファイルサイズ自動検証",
      "洗練された専用GUI",
    ],
    downloadUrl: "/downloads/underplay_dl_manager.py",
    badge: "無料配布",
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
    id: "credits-100",
    name: "都度チャージ",
    price: "¥500",
    period: "/ 100 Credits",
    description: "必要な分だけ都度購入。サブスクリプション不要でいつでも使えます。",
    features: [
      "100クレジット付与",
      "全アスペクト比（16:9 / 9:16 / 1:1）対応",
      "購入日から180日間有効",
      "追加チャージは何度でも",
    ],
    cta: "購入する",
  },
  {
    id: "standard-monthly",
    name: "月額スタンダード",
    price: "¥1,980",
    period: "/ 月",
    description: "毎月安定してStudioを使いたい方向けの月額プラン。",
    features: [
      "毎月500クレジットを自動付与",
      "サブスク会員特典として毎月更新",
      "全アスペクト比（16:9 / 9:16 / 1:1）対応",
      "いつでも解約可能",
    ],
    cta: "購入する",
    highlighted: true,
  },
  {
    id: "pro-monthly",
    name: "月額プロ",
    price: "¥4,980",
    period: "/ 月",
    description: "本格的に使い倒すクリエイター・受託案件向けの上位プラン。",
    features: [
      "毎月1,500クレジットを自動付与",
      "サブスク会員特典として毎月更新",
      "全アスペクト比（16:9 / 9:16 / 1:1）対応",
      "いつでも解約可能",
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
  "AIワークフロー設計・構築",
  "ComfyUI / Stable Diffusion カスタムノード開発",
  "大規模モデル配布・ダウンロード基盤",
  "MCP / エージェント自動化コンサル",
  "受託開発・技術顧問",
];
