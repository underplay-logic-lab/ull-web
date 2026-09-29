// 素材づくり（2026-09-27、ホスト構想「1 枚の画像から LoRA 用の素材一式を集められる Studio」）。
//
// マルチアングルと同じ編集モデル・同じワーカー・同じ課金（angle_jobs）を使い、角度 LoRA のトリガーを
// 付けずに「ポーズ・場面・構図・向き」を文章で指示する。実測（docs/STATUS.md 2026-09-27）: 参照 3 枚で
// 「雪原を笑って走る」「椅子に座る」「街を歩く」がキャラを保ったまま出た。向きを書かないと後ろ姿になる
// ことがあるので、向きは必ず指示に入れる。
//
// 1 回の指定枚数を 8 枚ずつのジョブに分けて順に投げる（GPU の 1 ジョブの時間上限と、最初の 1 ジョブで
// 方向を確認してから残りを作る流れのため）。生成した画像を次の参照に使わない（ユーザーが確定した参照だけを
// 毎回使う）ので、枚数が増えてもずれが連鎖しない。

import { angleCreditsPerAngle } from "@/lib/angleStudio";
import { DEFAULT_KNOBS, type PricingKnobs } from "@/lib/pricing/knobDefaults";

export type SceneChip = { id: string; label: string; en: string };

export const POSE_CHIPS: SceneChip[] = [
  { id: "standing", label: "立つ", en: "standing upright" },
  { id: "walking", label: "歩く", en: "walking" },
  { id: "running", label: "走る", en: "running" },
  { id: "sitting_chair", label: "椅子に座る", en: "sitting on a chair" },
  { id: "sitting_floor", label: "床に座る", en: "sitting on the floor" },
  { id: "arms_crossed", label: "腕組み", en: "standing with arms crossed" },
  { id: "waving", label: "手を振る", en: "waving one hand" },
  { id: "looking_back", label: "振り向く", en: "looking back over the shoulder" },
  { id: "jumping", label: "ジャンプ", en: "jumping in the air" },
  { id: "leaning", label: "壁にもたれる", en: "leaning against a wall" },
];

export const PLACE_CHIPS: SceneChip[] = [
  { id: "plain", label: "無地の背景", en: "against a plain white background" },
  { id: "room", label: "部屋", en: "in a cozy living room" },
  { id: "office", label: "オフィス", en: "in a modern office" },
  { id: "classroom", label: "教室", en: "in a school classroom" },
  { id: "cafe", label: "カフェ", en: "in a cafe" },
  { id: "street", label: "昼の街", en: "on a city street in the daytime" },
  { id: "night_street", label: "夜の街", en: "on a city street at night with neon lights" },
  { id: "park", label: "公園", en: "in a park with trees" },
  { id: "beach", label: "海辺", en: "on a sunny beach" },
  { id: "snow", label: "雪景色", en: "in a snowy field with snow falling" },
];

// 構図は文頭に置き、切れる位置と「写らないもの」を明記する（2026-09-27 初回実測: 文中の "upper body shot from the
// waist up" は 3/3 で全身になった。背景・ポーズは従ったので、構図の語だけ弱い）。
export const FRAMING_CHIPS: SceneChip[] = [
  { id: "full", label: "全身", en: "A full body shot showing the whole body from head to feet" },
  {
    id: "upper",
    label: "上半身",
    en: "A medium shot cropped at the waist, showing only the upper body (the legs and feet are outside the frame, the camera is close to the character)",
  },
  {
    id: "bust",
    label: "バストアップ",
    en: "A close-up bust shot cropped at the chest, showing only the head and shoulders (the camera is very close to the face)",
  },
];

export const VIEW_CHIPS: SceneChip[] = [
  { id: "front", label: "正面", en: "facing the viewer" },
  { id: "three_quarter", label: "斜め", en: "in a three-quarter view, turned slightly to the side" },
  { id: "side", label: "真横", en: "in profile view from the side" },
  { id: "back", label: "後ろ", en: "seen from behind" },
];

// 表情・服装（2026-09-28、ホスト指摘「全部スーツで似た画像ばかり」）。LoRA でも服装・表情の幅があると、
// 服やスーツを「人物の一部」として覚え込まず、プロンプトで変えやすくなる。
// 表情は感情の単語を使わず、顔のパーツの形だけで指示する（2026-09-30、3 回目）。
// 経緯: 強い表現（照れ・怒り・悲しみ）→ 真っ赤・アニメ調・別人。「少し〜」「赤面なし」に弱めても、shy/blush/pout 等の
// 単語そのものがアニメの誇張表情を連想させ、否定（no blushing）も効かなかった。形の指示＋ネガティブプロンプト
// （sceneNegativePrompt）で抑える。id は保存済みの選択と互換。
export const EXPRESSION_CHIPS: SceneChip[] = [
  { id: "neutral", label: "真顔", en: "with a calm neutral expression" },
  { id: "smile", label: "微笑み", en: "with the corners of the mouth slightly raised in a soft closed-mouth smile" },
  { id: "laugh", label: "歯を見せて笑う", en: "with a natural open-mouth smile showing a little of the upper teeth" },
  { id: "surprised", label: "少し驚き", en: "with the eyebrows slightly raised, the eyes a little wider than usual and the mouth slightly open" },
  { id: "shy", label: "少しはにかむ", en: "with the head tilted slightly down, the eyes looking slightly to the side and a small closed-mouth smile" },
  { id: "angry", label: "少し口をとがらせる", en: "with the lips pushed slightly forward, while the eyebrows and eyes stay relaxed and neutral" },
  { id: "sad", label: "少し寂しげ", en: "with the corners of the mouth slightly lowered and the eyelids slightly lowered, the eyebrows relaxed" },
];

/** 元画像の画風（2026-09-30）。photo のときはアニメ・イラスト調をネガティブに入れる（実写がアニメ調に転ぶ対策）。 */
export type SourceStyle = "auto" | "photo" | "illust";

/**
 * 素材づくりの本生成に付けるネガティブプロンプト（2026-09-30）。本文の「〜なし」はこの種のモデルでは効かないので、
 * 避けたいものはネガティブ側へ。赤面・涙・誇張した表情・険しい目は常に、画風は選んだときだけ。
 */
export function sceneNegativePrompt(style: SourceStyle): string {
  const base = "blush, flushed red cheeks, red face, tears, crying, exaggerated facial expression, glaring eyes, furrowed brows, angry eyes";
  if (style === "photo") return `${base}, anime, cartoon, illustration, drawing, manga, 3d render, cgi, doll-like skin`;
  if (style === "illust") return `${base}, photorealistic, photograph, real person`;
  return base;
}

export const OUTFIT_CHIPS: SceneChip[] = [
  { id: "same", label: "元の服装のまま", en: "" },
  { id: "casual", label: "カジュアル", en: "wearing casual clothes (a t-shirt and jeans)" },
  { id: "suit", label: "スーツ", en: "wearing a formal business suit" },
  { id: "winter", label: "冬のコート", en: "wearing a warm winter coat and a scarf" },
  { id: "sports", label: "スポーツウェア", en: "wearing sportswear" },
  { id: "loungewear", label: "部屋着", en: "wearing comfortable loungewear" },
  { id: "yukata", label: "浴衣", en: "wearing a traditional Japanese yukata" },
];

export type SceneAxis = "poses" | "places" | "framings" | "views" | "expressions" | "outfits";

export type SceneSelection = {
  poses: string[];
  places: string[];
  framings: string[];
  views: string[];
  expressions: string[];
  outfits: string[];
  /** 自分で足したポーズ・場面（日本語可）。指示に入った日本語は API 側で英訳する（2026-09-27）。 */
  customPoses: string[];
  customPlaces: string[];
  /** 服装の指定（任意・日本語可）。 */
  outfit: string;
  /** 自由記述（任意・日本語可）。 */
  extra: string;
  /**
   * 構図・向きの比率（%、2026-09-29 ホスト判断「後ろは少し・全身は少なめ。均等ではなく、どの素材も同じような比率で」）。
   * チップ id → %。選んでいないチップは無視し、選んだチップの値で割り振る（合計が 100 でなくても比で扱う）。
   * 空欄（0・無し）のチップは、100% の残りを均等に分ける。
   */
  ratios?: Partial<Record<RatioAxis, Record<string, number>>>;
};

/** 比率を指定できる軸。 */
export type RatioAxis = "framings" | "views";

/**
 * 既定の比率（2026-09-29）。人物 LoRA は顔が本題なので寄りを厚く（診断の目安: 寄り 30%・上半身 30%・全身 15% 以上）、
 * 後ろ姿は顔が写らないので少なく。48 枚なら 全身 12・上半身 18・バスト 18／正面 20・斜め 20・真横 6・後ろ 2。
 */
export const DEFAULT_SCENE_RATIOS: Record<RatioAxis, Record<string, number>> = {
  framings: { full: 25, upper: 38, bust: 37 },
  views: { front: 42, three_quarter: 41, side: 13, back: 4 },
};

// LoRA 素材の既定: 立つ・歩く・座る × 無地・部屋・街 × 全身・上半身 × 正面・斜め。
export const DEFAULT_SCENE_SELECTION: SceneSelection = {
  poses: ["standing", "walking", "sitting_chair"],
  places: ["plain", "room", "street"],
  framings: ["full", "upper", "bust"],
  views: ["front", "three_quarter", "side", "back"],
  expressions: ["smile", "neutral"],
  outfits: ["same", "casual"],
  customPoses: [],
  customPlaces: [],
  outfit: "",
  extra: "",
  ratios: DEFAULT_SCENE_RATIOS,
};

export const CHIPS_BY_AXIS: Record<SceneAxis, SceneChip[]> = {
  poses: POSE_CHIPS,
  places: PLACE_CHIPS,
  framings: FRAMING_CHIPS,
  views: VIEW_CHIPS,
  expressions: EXPRESSION_CHIPS,
  outfits: OUTFIT_CHIPS,
};

/** 1 ジョブに入れる枚数。GPU の 1 ジョブの時間上限と「最初の 1 ジョブで確認」の単位。 */
export const SCENE_BATCH_SIZE = 8;
export const SCENE_DEFAULT_COUNT = 24;
export const SCENE_MAX_COUNT = 400;

export type ScenePlanItem = {
  key: string;
  framingId: string;
  viewId: string;
  /** 「何をどこで」の英語（チップから組み立てた既定）。 */
  bodyEn: string;
  /** 同じ内容の日本語（実行前の一覧に出す）。 */
  bodyJa: string;
  /** ユーザーが一覧で書き換えた内容（日本語可・API 側で英訳）。あれば bodyEn の代わりに使う。 */
  custom?: string;
};

// 顔立ちを保つ＋表情は控えめに＋画風を保つ（2026-09-29: 表情指定で別人・アニメ調に転んだ対策）。
const IDENTITY_EN =
  "Keep the same character with the identical face, hairstyle, body shape and clothing as the reference. Any change of expression must be subtle and must not alter the facial features. Keep the same art style, rendering and level of realism as the reference (if the reference is a photo, keep it a photorealistic photo).";

function chip(axis: SceneAxis, id: string): SceneChip {
  return CHIPS_BY_AXIS[axis].find((c) => c.id === id) ?? CHIPS_BY_AXIS[axis][0];
}

/** ワーカーへ送る英語の指示（構図・向きを先頭に、本文、同一性の順）。本文が日本語なら API 側で英訳される。 */
export function scenePlanInstruction(item: ScenePlanItem): string {
  const framing = chip("framings", item.framingId);
  const view = chip("views", item.viewId);
  const body = (item.custom ?? "").trim() || item.bodyEn;
  return `${framing.en}, ${view.en}. ${body.replace(/[。.]\s*$/, "")}. ${IDENTITY_EN}`;
}

/** 一覧・結果のラベル（日本語）。 */
export function scenePlanLabel(item: ScenePlanItem): string {
  const framing = chip("framings", item.framingId);
  const view = chip("views", item.viewId);
  const body = (item.custom ?? "").trim() || item.bodyJa;
  return `${body}（${framing.label}・${view.label}）`;
}

/** 実行前の一覧に出す日本語の全文。 */
export function scenePlanPreviewJa(item: ScenePlanItem): string {
  const framing = chip("framings", item.framingId);
  const view = chip("views", item.viewId);
  return `${framing.label}・${view.label}で、${(item.custom ?? "").trim() || item.bodyJa}`;
}

function pick(axis: SceneAxis, ids: string[], custom: string[] = []): SceneChip[] {
  const set = new Set(ids);
  const fixed = CHIPS_BY_AXIS[axis].filter((c) => set.has(c.id));
  const extra = custom
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ id: `custom:${t}`, label: t, en: t }));
  return [...fixed, ...extra];
}

/**
 * 選んだチップの組み合わせを、ばらつきが早く出る順（各軸を回しながら）に並べて count 枚ぶん返す。
 * 組み合わせが count に足りなければ先頭から繰り返す（ワーカーは seed + index で散らすので同じ絵にはならない）。
 * 未選択の軸は既定（ポーズ=立つ／場所=無地／構図=全身／向き=正面）で埋める。
 */
/** 選んだチップの実効の比率（合計 1）。空欄は 100% の残りを均等に、全部 0 なら均等。 */
export function effectiveRatios(chips: SceneChip[], ratios: Record<string, number> | undefined): number[] {
  const set = chips.map((c) => Math.max(0, Number(ratios?.[c.id] ?? 0) || 0));
  const empty = set.filter((v) => v === 0).length;
  const left = Math.max(0, 100 - set.reduce((a, b) => a + b, 0));
  const w = set.map((v) => (v > 0 ? v : empty > 0 ? left / empty : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 0 ? w.map((x) => x / sum) : chips.map(() => 1 / chips.length);
}

/**
 * 比率つきの配分（長さ n の並び）。最大剰余で枚数に丸め、選んだチップは n が足りる限り最低 1 枚。並びは各チップが
 * 全体に散らばるように（最初の確認 8 枚にもなるべく全部が入るように）先頭から比率どおりに埋める。
 */
function quotaSequence(chips: SceneChip[], ratios: Record<string, number> | undefined, n: number): SceneChip[] {
  const r = effectiveRatios(chips, ratios);
  const exact = r.map((x) => x * n);
  const target = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (let rest = n - target.reduce((a, b) => a + b, 0), j = 0; rest > 0; rest--, j++) target[order[j % order.length][1]]++;
  if (n >= chips.length) {
    for (let i = 0; i < chips.length; i++) {
      if (target[i] > 0) continue;
      const donor = target.indexOf(Math.max(...target));
      target[donor]--;
      target[i]++;
    }
  }
  const seq: SceneChip[] = [];
  const done = chips.map(() => 0);
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestGap = -Infinity;
    for (let c = 0; c < chips.length; c++) {
      if (done[c] >= target[c]) continue;
      const gap = (target[c] * (i + 1)) / n - done[c];
      if (gap > bestGap) {
        bestGap = gap;
        best = c;
      }
    }
    if (best < 0) break;
    done[best]++;
    seq.push(chips[best]);
  }
  return seq;
}

export function buildScenePlan(sel: SceneSelection, count: number): ScenePlanItem[] {
  const n = Math.max(0, Math.min(SCENE_MAX_COUNT, Math.trunc(count || 0)));
  if (n === 0) return [];
  const poses = pick("poses", sel.poses, sel.customPoses ?? []);
  const places = pick("places", sel.places, sel.customPlaces ?? []);
  const framings = pick("framings", sel.framings);
  const views = pick("views", sel.views);
  const expressions = pick("expressions", sel.expressions ?? []);
  const outfits = pick("outfits", sel.outfits ?? []);
  const P = poses.length ? poses : [POSE_CHIPS[0]];
  const L = places.length ? places : [PLACE_CHIPS[0]];
  const F = framings.length ? framings : [FRAMING_CHIPS[0]];
  const V = views.length ? views : [VIEW_CHIPS[0]];
  const E = expressions.length ? expressions : [EXPRESSION_CHIPS[0]];
  const O = outfits.length ? outfits : [OUTFIT_CHIPS[0]];
  const total = P.length * L.length * F.length * V.length;
  const outfitText = sel.outfit.trim();
  const extra = sel.extra.trim();

  const items: ScenePlanItem[] = [];
  // バストアップ × 後ろ＝後頭部のアップは LoRA 素材として価値が低いので既定で外す（2026-09-28、ホスト指摘）。
  // 真横 × バストアップ（横顔）は残す。除外した分は次の組み合わせで埋める。
  const skip = (framing: SceneChip, view: SceneChip) => framing.id === "bust" && view.id === "back";
  const pushItem = (i: number, pose: SceneChip, place: SceneChip, framing: SceneChip, view: SceneChip) => {
    const expr = E[i % E.length];
    const outfitChip = O[Math.floor(i / E.length) % O.length];
    const outfitEn = outfitText ? `wearing ${outfitText}` : outfitChip.en;
    const outfitJa = outfitText ? `服装: ${outfitText}` : outfitChip.id === "same" ? "" : `服装: ${outfitChip.label}`;
    const exprEn = view.id === "back" ? "" : expr.en;
    const exprJa = view.id === "back" ? "" : `表情: ${expr.label}`;
    const bodyEn = [`Make the character ${pose.en} ${place.en}`, exprEn, outfitEn, extra].filter(Boolean).join(", ");
    const bodyJa = [`${place.label}で${pose.label}`, exprJa, outfitJa, extra].filter(Boolean).join("、");
    items.push({
      key: `${i}:${pose.id}|${place.id}|${framing.id}|${view.id}|${expr.id}|${outfitChip.id}`,
      framingId: framing.id,
      viewId: view.id,
      bodyEn,
      bodyJa,
    });
  };

  // 比率（既定あり）: 軸ごとに比率どおりの並びを作り、向きは「足りていない順」に割り当てる（バストアップ×後ろは避ける）。
  // ポーズ・場面は行ごとに回す。比率が無い（古い保存）ときは従来の均等な組み合わせ。
  if (sel.ratios) {
    const fSeq = quotaSequence(F, sel.ratios.framings, n);
    const vSeq = quotaSequence(V, sel.ratios.views, n);
    const vTarget = new Map<string, number>();
    for (const v of vSeq) vTarget.set(v.id, (vTarget.get(v.id) ?? 0) + 1);
    const vDone = new Map<string, number>();
    for (let i = 0; i < fSeq.length; i++) {
      const framing = fSeq[i];
      let view: SceneChip | undefined;
      let bestGap = -Infinity;
      for (const v of V) {
        const t = vTarget.get(v.id) ?? 0;
        const d = vDone.get(v.id) ?? 0;
        if (d >= t || skip(framing, v)) continue;
        const gap = (t * (i + 1)) / n - d;
        if (gap > bestGap) {
          bestGap = gap;
          view = v;
        }
      }
      // 残りが「後ろ」だけでバストアップに当たったら、使える向きのうち指定の多いものに振り替える（1 枚だけずれる）。
      if (!view) view = V.filter((v) => !skip(framing, v)).sort((a, b) => (vTarget.get(b.id) ?? 0) - (vTarget.get(a.id) ?? 0))[0] ?? V[0];
      vDone.set(view.id, (vDone.get(view.id) ?? 0) + 1);
      pushItem(i, P[i % P.length], L[Math.floor(i / P.length) % L.length], framing, view);
    }
    return items;
  }

  for (let i = 0, k0 = 0; i < n; i++, k0++) {
    let k = k0 % total;
    for (let guard = 0; guard < total; guard++) {
      const fr = F[(k + Math.floor(k / (P.length * L.length))) % F.length];
      const vw = V[(Math.floor(k / F.length) + Math.floor(k / (P.length * L.length * F.length))) % V.length];
      if (!skip(fr, vw)) break;
      k0++;
      k = k0 % total;
    }
    // 隣り合う枚で違う軸が動くように、各軸を互いに素な歩幅で回す。
    const pose = P[k % P.length];
    const place = L[Math.floor(k / P.length) % L.length];
    const framing = F[(k + Math.floor(k / (P.length * L.length))) % F.length];
    const view = V[(Math.floor(k / F.length) + Math.floor(k / (P.length * L.length * F.length))) % V.length];
    // 表情・服装は行ごとに順に回す（構図・向きの組み合わせとは独立に散らす）。自由入力の服装があればそれを優先。
    // 後ろ向きでは表情が見えないので付けない（pushItem 内）。
    pushItem(i, pose, place, framing, view);
  }
  return items;
}

export function chunkPlan<T>(items: T[], size = SCENE_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// 参照（後ろ姿・真横など）が要るのは、メイン画像に写っていない側を描く行だけ（2026-09-27、ホスト承認）。
// 正面・斜めの行はメイン 1 枚で作る（1 枚 約 24 秒・14C）。参照 3 枚を付けると約 50 秒・係数付きの料金になるので、
// 向きで使い分けるとほとんどの行が半分以下になる。
const VIEWS_NEED_REFS = new Set(["side", "back"]);

export function sceneItemNeedsRefs(item: ScenePlanItem, subCount: number): boolean {
  return subCount > 0 && VIEWS_NEED_REFS.has(item.viewId);
}

// 上半身・バストアップは文章の指示では効かない（2026-09-27 実測: 2 回で 1/11）。このモデルは入力画像の構図を強く
// 保つ（距離の語なしでバストの元→バストのまま）ので、寄りの行は「寄りの元画像」（ユーザーが参照の中から指定）を
// メインにして作る。参照は付けない（顔と上着は寄りの元に写っている）。
export type CloseFraming = "upper" | "bust";
/** 構図ごとの「寄りの元画像」（参照の index）。バストアップの元からは腰から上に広がらないので、構図ごとに分ける。 */
export type CloseMainMap = Partial<Record<CloseFraming, number | null>>;

/** ジョブの画像セットの種類。同じ種類の行だけ 1 ジョブにまとめる。 */
export type SceneGroup = "main" | "close:upper" | "close:bust" | "refs" | "mixed";

export type SceneBatchOptions = {
  subCount: number;
  closeMain: CloseMainMap;
  /** メイン画像から自動で切り出した寄りの元があるか（構図ごと）。参照の指定が無いときに使う。 */
  derived?: Partial<Record<CloseFraming, boolean>>;
  /** 後ろ姿・真横の参照が確定しているか。あれば該当の向きの行にはその 1 枚だけ付ける（2026-09-28、速く安く）。 */
  hasBackRef?: boolean;
  hasSideRef?: boolean;
};

/** この行に付ける参照の枚数。後ろ→後ろ姿 1 枚、真横→真横 1 枚。専用の参照が無ければ従来どおり参照欄の全部。 */
export function sceneItemRefCount(item: ScenePlanItem, opt: SceneBatchOptions): number {
  if (item.viewId === "back") return opt.hasBackRef ? 1 : opt.subCount;
  if (item.viewId === "side") return opt.hasSideRef ? 1 : opt.subCount;
  return 0;
}

/** この行が「寄りの元画像」（参照の指定 or 自動切り出し）から作られるか。 */
export function sceneItemUsesCloseSource(item: ScenePlanItem, opt: SceneBatchOptions): boolean {
  if (item.framingId !== "upper" && item.framingId !== "bust") return false;
  return closeMainIndexFor(item, opt) !== null || Boolean(opt.derived?.[item.framingId]);
}

export function closeMainIndexFor(item: ScenePlanItem, opt: SceneBatchOptions): number | null {
  if (item.framingId !== "upper" && item.framingId !== "bust") return null;
  const idx = opt.closeMain[item.framingId];
  return typeof idx === "number" && idx >= 0 && idx < opt.subCount ? idx : null;
}

export function sceneItemGroup(item: ScenePlanItem, opt: SceneBatchOptions): SceneGroup {
  if (sceneItemNeedsRefs(item, opt.subCount)) return "refs";
  if (sceneItemUsesCloseSource(item, opt)) return item.framingId === "upper" ? "close:upper" : "close:bust";
  return "main";
}

export type SceneBatch = { items: ScenePlanItem[]; group: SceneGroup; useRefs: boolean };

const GROUP_ORDER: SceneGroup[] = ["main", "close:upper", "close:bust", "refs"];

function groupSorted(items: ScenePlanItem[], opt: SceneBatchOptions): ScenePlanItem[] {
  return GROUP_ORDER.flatMap((g) => items.filter((it) => sceneItemGroup(it, opt) === g));
}

/**
 * 実行順に並べ替える（run.plan にはこの並びで保存し、結果の順と一致させる）。
 * 先頭は「最初に確認する行」＝「先に作る」で選んだ行（無ければ先頭 SCENE_BATCH_SIZE 行）。種類が違っても全部入れる
 * （2026-09-27、ホスト指摘「全身とバストアップを選んだのに上半身しか来ない」）。その後ろに残りの行。どちらも
 * 種類ごと（メインだけ → 寄りの元 → 参照付き）にまとめる。
 * 返り値の prefixLen は「最初に確認する行」の数。planBatches はこの境界でジョブを分ける。
 */
export function orderPlanForBatches(
  plan: ScenePlanItem[],
  opt: SceneBatchOptions,
  firstKeys: Set<string> = new Set(),
): { plan: ScenePlanItem[]; prefixLen: number } {
  const first = firstKeys.size > 0 ? plan.filter((it) => firstKeys.has(it.key)) : plan.slice(0, SCENE_BATCH_SIZE);
  const firstSet = new Set(first.map((it) => it.key));
  const rest = plan.filter((it) => !firstSet.has(it.key));
  return { plan: [...groupSorted(first, opt), ...groupSorted(rest, opt)], prefixLen: first.length };
}

/** 確認の後の塊の大きさ。ワーカーが行ごとの画像セットを受けられるので（2026-09-28）、種類が違っても 1 ジョブにまとめる。 */
export const SCENE_REST_BATCH_SIZE = 16;

/**
 * prefixLen（最初に確認する行）の境界でだけジョブを分け、前半は SCENE_BATCH_SIZE、後半は SCENE_REST_BATCH_SIZE ずつに切る。
 * 元画像の種類が違う行も同じジョブに入る（行ごとの画像セット）。
 */
export function planBatches(plan: ScenePlanItem[], opt: SceneBatchOptions, prefixLen = 0): SceneBatch[] {
  void opt;
  const out: SceneBatch[] = [];
  const cut = Math.max(0, Math.min(plan.length, prefixLen));
  for (const items of chunkPlan(plan.slice(0, cut), SCENE_BATCH_SIZE)) out.push({ items, group: "mixed", useRefs: false });
  for (const items of chunkPlan(plan.slice(cut), SCENE_REST_BATCH_SIZE)) out.push({ items, group: "mixed", useRefs: false });
  return out;
}

/** 「最初に確認する行」を流し切るのに要るジョブ数。 */
export function checkBatchCount(plan: ScenePlanItem[], opt: SceneBatchOptions, prefixLen: number): number {
  let n = 0;
  let covered = 0;
  for (const b of planBatches(plan, opt, prefixLen)) {
    if (covered >= prefixLen) break;
    covered += b.items.length;
    n += 1;
  }
  return Math.max(1, n);
}

export function sceneItemCredits(item: ScenePlanItem, knobs: PricingKnobs, opt: SceneBatchOptions): number {
  return sceneCreditsPerImage(knobs, sceneItemRefCount(item, opt));
}

export function scenePlanCredits(plan: ScenePlanItem[], knobs: PricingKnobs, opt: SceneBatchOptions): number {
  return plan.reduce((t, it) => t + sceneItemCredits(it, knobs, opt), 0);
}

/** 参照枚数に応じた 1 枚あたりのクレジット（マルチアングルと同じ単価・同じ係数）。 */
export function sceneCreditsPerImage(knobs: PricingKnobs = DEFAULT_KNOBS, subImageCount = 0): number {
  return angleCreditsPerAngle(knobs, subImageCount);
}

export function sceneTotalCredits(count: number, knobs: PricingKnobs = DEFAULT_KNOBS, subImageCount = 0): number {
  return Math.max(0, Math.trunc(count || 0)) * sceneCreditsPerImage(knobs, subImageCount);
}

// --- 体の設計（顔アップ→全身、2026-09-29） -------------------------------------------------------
// 顔アップだけの画像から全身を作ると、体つき・服装はモデルの想像まかせで候補ごとにばらばらになる（実測: 服の指定なしだと
// 下はジーンズ／裸足／ミニ丈と毎回ちがう。指定すると 8/8 で揃った）。そこで基準の全身を作る前に服・体型・背丈を決める。
// 顔の似方は候補ごとにばらつくので、候補から気に入った顔を選んでもらう（選んだ全身がそのキャラの正解になる）。

/** 取り込んだ画像の写り方による経路。face＝顔アップ（体の設計が必須）、upper＝上半身（下の服は任意）、full＝全身（不要）。 */
export type MainRoute = "face" | "upper" | "full";

export const BODY_OUTFIT_CHIPS: SceneChip[] = [
  { id: "casual", label: "Tシャツとジーンズ", en: "a plain t-shirt and blue jeans" },
  { id: "blazer", label: "ブレザー制服", en: "a navy blazer over a white shirt and a pleated skirt or slacks" },
  { id: "sailor", label: "セーラー服", en: "a Japanese sailor school uniform with a pleated skirt" },
  { id: "suit", label: "スーツ", en: "a formal business suit" },
  { id: "dress", label: "ワンピース", en: "a simple knee-length dress" },
  { id: "hoodie", label: "パーカー", en: "a hoodie and casual pants" },
];

// 靴は服と別に選ぶ（2026-09-29 ホスト指摘）。足元まで写す全身では靴も毎回ちがうと揃わない。
export const BODY_SHOES_CHIPS: SceneChip[] = [
  { id: "sneakers", label: "スニーカー", en: "white sneakers" },
  { id: "loafers", label: "ローファー", en: "black loafers" },
  { id: "leather", label: "革靴", en: "black leather shoes" },
  { id: "pumps", label: "パンプス", en: "low-heeled pumps" },
  { id: "boots", label: "ブーツ", en: "ankle boots" },
  { id: "sandals", label: "サンダル", en: "sandals" },
  { id: "barefoot", label: "裸足", en: "barefoot" },
];

// 体型・背丈は「おまかせ」（id ""＝指定しない。元画像から推測させる）が既定（2026-09-29 ホスト「選択肢は多い方が良い」）。
export const BODY_BUILD_CHIPS: SceneChip[] = [
  { id: "", label: "おまかせ", en: "" },
  { id: "skinny", label: "痩せ型", en: "very slim, slender build" },
  { id: "slim", label: "細身", en: "slim build" },
  { id: "average", label: "標準", en: "average build" },
  { id: "muscular", label: "筋肉質", en: "muscular, toned build" },
  { id: "athletic", label: "がっしり", en: "athletic, sturdy build" },
  { id: "chubby", label: "ぽっちゃり", en: "slightly chubby, soft build" },
  { id: "curvy", label: "ふくよか", en: "curvy, full-figured build" },
];

export const BODY_HEIGHT_CHIPS: SceneChip[] = [
  { id: "", label: "おまかせ", en: "" },
  { id: "petite", label: "小柄", en: "petite, short height" },
  { id: "average", label: "平均", en: "average height" },
  { id: "tall", label: "長身", en: "tall" },
];

export type BodyDesign = {
  /** 服装チップの id（空＝未選択）。outfitText があればそちらを優先。 */
  outfitId: string;
  /** 服装の自由入力（日本語可、API 側で英訳）。 */
  outfitText: string;
  /** 靴（空＝指定なし。服の自由入力に書いてあればそれでもよい）。 */
  shoesId?: string;
  buildId: string;
  heightId: string;
  /** 体の特徴の自由入力（任意・日本語可、2026-09-29）。例: 胸は控えめ・なで肩・脚が長い。 */
  featuresText?: string;
};

export const EMPTY_BODY_DESIGN: BodyDesign = {
  outfitId: "",
  outfitText: "",
  shoesId: "",
  buildId: "",
  heightId: "",
  featuresText: "",
};

/** 体型・背丈・体の特徴の英文（無ければ ""）。 */
function bodyShapeEn(design: BodyDesign): string {
  const build = BODY_BUILD_CHIPS.find((c) => c.id === design.buildId)?.en || undefined;
  const height = BODY_HEIGHT_CHIPS.find((c) => c.id === design.heightId)?.en || undefined;
  const body = [build, height].filter(Boolean).join(", ");
  const features = (design.featuresText ?? "").trim();
  return [body ? `The character has a ${body}.` : "", features ? `Body details: ${features}.` : ""].filter(Boolean).join(" ");
}

/** 全身から始めて体つきを調整するとき、何か 1 つでも指定があるか。 */
export function bodyDesignHasAdjustment(design: BodyDesign): boolean {
  return Boolean(bodyShapeEn(design) || bodyOutfitEn(design));
}

function bodyOutfitEn(design: BodyDesign): string {
  const text = design.outfitText.trim();
  const clothes = text || (BODY_OUTFIT_CHIPS.find((c) => c.id === design.outfitId)?.en ?? "");
  if (!clothes) return "";
  const shoes = BODY_SHOES_CHIPS.find((c) => c.id === design.shoesId);
  if (!shoes) return clothes;
  return shoes.id === "barefoot" ? `${clothes}, barefoot` : `${clothes} and ${shoes.en}`;
}

/** 候補を作れない理由（無ければ null）。顔アップは服装が必須（上半身は下の服が元画像に無いだけなので任意）。 */
export function bodyDesignBlockedReason(design: BodyDesign, route: MainRoute): string | null {
  if (route === "face" && !bodyOutfitEn(design)) return "先に服装を選ぶか入力してください（顔だけの画像なので、体と服をここで決めます）。";
  if (route === "full" && !bodyDesignHasAdjustment(design)) return "変えたい項目（体型・背丈・体の特徴・服）を 1 つ以上指定してください。";
  return null;
}

/**
 * 基準の全身の候補の指示（4 枚分）。full は「全身から始めて体つきを調整する」とき（2026-09-29）: 顔・髪・服は元のまま、
 * 指定した体型・背丈・体の特徴（と服を指定したときは服）だけ変える。
 */
export function bodyDesignSpecs(design: BodyDesign, route: MainRoute, count = 4): { instruction: string; label: string }[] {
  const outfit = bodyOutfitEn(design);
  const shape = bodyShapeEn(design);
  const base = "A full body shot showing the whole body from head to feet, standing upright, facing the viewer, against a plain white background.";
  let rest: string;
  if (route === "face") {
    rest = `The character is wearing ${outfit}.${shape ? ` ${shape}` : ""} Keep the identical face and hairstyle as the reference.`;
  } else if (route === "upper") {
    // 上半身: 写っている服は引き継ぎ、写っていない下半身だけ指定を使う。
    rest = `Keep the same character with the identical face, hairstyle and the clothing visible in the reference.${
      outfit ? ` For the parts not visible in the reference, the character is wearing ${outfit}.` : ""
    }${shape ? ` ${shape}` : ""}`;
  } else {
    rest = `Keep the same character with the identical face and hairstyle as the reference.${
      outfit ? ` The character is now wearing ${outfit}.` : " Keep the same clothing as the reference."
    }${shape ? ` Change only the body as follows: ${shape}` : ""}`;
  }
  return Array.from({ length: count }, (_, i) => ({ instruction: `${base} ${rest}`, label: `全身の候補 ${i + 1}` }));
}

/**
 * かんたん（基準の全身像を作らない）ときに本生成の各画像へ足す体の指示（2026-09-29）。顔アップだけだと体と服が
 * 画像ごとにでたらめになるので、体の設計を毎回添える。行ごとの服装チップ（「元の服装のまま」以外）があればそちらが優先。
 */
export function bodyDesignSentence(design: BodyDesign): string {
  const outfit = bodyOutfitEn(design);
  const shape = bodyShapeEn(design);
  return [
    outfit ? `Unless another outfit is specified above, the character is wearing ${outfit}.` : "",
    shape,
  ]
    .filter(Boolean)
    .join(" ");
}

/** smartCrop の framing から経路を決める（手動の指定があればそちら）。 */
export function mainRouteOf(framing: string | undefined, override: MainRoute | "auto"): MainRoute | null {
  if (override !== "auto") return override;
  if (framing === undefined) return null;
  if (framing === "full") return "full";
  if (framing === "upper") return "upper";
  return "face";
}
