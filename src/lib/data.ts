export const siteConfig = {
  name: "UNDERPLAY LOGIC LAB",
  shortName: "UPLL",
  tagline: "AI Generation & Automation",
  description:
    "AI生成の自動化と独自ツールの配布を行う、AIクリエイター・自動化エンジニアのためのWeb拠点。",
  // Short brand form for general display (footer copyright, etc.)
  author: "ULL",
  // Formal registered name for legal disclosures (e.g. /tokushoho)
  legalName: "Underplay Logic Lab",
};

export const navLinks = [
  { label: "Studio", href: "/#studio" },
  { label: "Products", href: "/#products" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Articles", href: "/#articles" },
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
      "Civitai / Hugging Face など複数ソースからの並列ダウンロード、自動仕分け、高速マージを一体化。AI開発環境のセットアップ時間を劇的に短縮します。",
    quickBadges: ["4並列DL", "自動仕分け", "高速マージ"],
    features: [
      "4並列ダウンロード接続で帯域を最大活用",
      "拡張子・種別ごとの自動フォルダ仕分け",
      "分割ダウンロードの高速マージ処理",
      "中断・再開（レジューム）対応",
      "SHA256 / ファイルサイズ自動検証",
      "CLI / GUI デュアルモード",
    ],
    downloadUrl: "/downloads/underplay_dl_manager.py",
    badge: "無料配布",
  },
  {
    id: "comfyui-turbo-lora",
    name: "ComfyUI Turbo LoRA Suite",
    version: "v1.0",
    tagline: "LoRA推論パイプラインを極限まで最適化",
    description:
      "ComfyUI向けカスタムノード群。LoRAの動的ロード、アテンション最適化、VRAM効率化をワンクリックで実現。Stable Diffusion / Flux ワークフローの生成速度を大幅に向上させます。",
    quickBadges: ["遅延ロード", "VRAM最適化", "バッチ推論"],
    features: [
      "Turbo LoRA Loader — 遅延ロード & キャッシュ",
      "Attention Slicing / xFormers 自動切替",
      "VRAM使用量リアルタイムモニタリング",
      "プリセット: SDXL / Flux / Pony 対応",
      "バッチ推論パイプライン最適化",
      "ワンクリック ワークフロー テンプレート",
    ],
    badge: "近日公開",
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
    id: "credits-10",
    name: "都度チャージ",
    price: "¥500",
    period: "/ 10 Credits",
    description: "必要な分だけチャージ。有効期限なしでいつでも使えます。",
    features: [
      "Studio生成 10回分のクレジット",
      "全アスペクト比（16:9 / 9:16 / 1:1）対応",
      "有効期限なし",
      "追加チャージは何度でも",
    ],
    cta: "購入する",
  },
  {
    id: "creator-pro",
    name: "Creator Pro",
    price: "¥2,000",
    period: "/ 月",
    description: "毎日使い放題。本格的にAI生成を使い倒すクリエイター向けサブスクリプション。",
    features: [
      "毎日生成し放題（クレジット消費なし）",
      "優先生成キューで待ち時間を短縮",
      "配布ツールをすべて無料ダウンロード",
      "生成物の商用利用ライセンス付き",
      "いつでも解約可能",
    ],
    cta: "購入する",
    highlighted: true,
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
