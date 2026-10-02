// 操作動画の編集ロジック（純関数）。録画（scripts/record.mjs）の session.json と、手で書く edit.json から
// 「書き出しの何フレーム目に、録画の何秒目を、どこへ寄って映すか」を決める。

export type RecEvent =
  | { type: "move"; t: number; x: number; y: number }
  | { type: "click"; t: number; x: number; y: number; label?: string }
  | { type: "scroll" | "key" | "mark"; t: number }
  | { type: "nav"; t: number; url: string };

export type Session = {
  name: string;
  view: { width: number; height: number };
  dpr: number;
  duration: number; // ms
  frames: { f: string; t: number }[]; // t は ms・昇順
  events: RecEvent[]; // 昇順
};

export type Caption = { at: number; text: string; dur?: number; zoom?: number };

export type Edit = {
  title?: string;
  captions: Caption[];
  trimStart?: number; // 録画の先頭を何秒捨てるか
  trimEnd?: number; // 録画の何秒目で終えるか
  idleGap?: number; // この秒数以上操作が無い所を早送りする（GPU 待ちなど）
  idleKeep?: number; // 早送りの前後に等速で残す秒数
  idleOut?: number; // 早送り区間を書き出しで何秒に縮めるか
  zoom?: number; // クリック時に寄る倍率（1 で寄らない）
  noZoom?: [number, number][]; // この区間（録画の秒）は寄らない
  cuts?: [number, number][]; // この区間（録画の秒）を切り落とす（操作のやり直し等）
};

// 録画の区間 [from, to)（秒）を speed 倍で流す。
export type Segment = { from: number; to: number; speed: number };

const DEFAULTS = { idleGap: 6, idleKeep: 1.2, idleOut: 1.5, zoom: 1.6 };
export const opts = (e: Edit) => ({ ...DEFAULTS, ...e });

export function buildSegments(s: Session, edit: Edit): Segment[] {
  const start = edit.trimStart ?? 0;
  const end = Math.min(edit.trimEnd ?? Infinity, s.duration / 1000);
  // 切り落とす区間を除いた残りを、それぞれ同じ規則で早送りしてつなぐ。
  const kept: [number, number][] = [];
  let cur = start;
  for (const [a, b] of [...(edit.cuts ?? [])].sort((x, y) => x[0] - y[0])) {
    if (b <= cur || a >= end) continue;
    if (a > cur) kept.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (end > cur) kept.push([cur, end]);
  return kept.flatMap(([a, b]) => buildRange(s, edit, a, b));
}

function buildRange(s: Session, edit: Edit, start: number, end: number): Segment[] {
  const o = opts(edit);
  // 「操作している」とみなす時刻。マウスを揺らしているだけの待ち時間は早送りしたいので move は数えない。
  const acts = s.events
    .filter((e) => e.type !== "move")
    .map((e) => e.t / 1000)
    .filter((t) => t > start && t < end);
  const points = [start, ...acts, end];
  const segs: Segment[] = [];
  let cur = start;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (b - a < o.idleGap) continue;
    const ffFrom = a + o.idleKeep;
    const ffTo = b - o.idleKeep;
    if (ffFrom > cur) segs.push({ from: cur, to: ffFrom, speed: 1 });
    segs.push({ from: ffFrom, to: ffTo, speed: (ffTo - ffFrom) / o.idleOut });
    cur = ffTo;
  }
  if (end > cur) segs.push({ from: cur, to: end, speed: 1 });
  return segs.filter((g) => g.to > g.from);
}

export const outLength = (segs: Segment[]) => segs.reduce((a, g) => a + (g.to - g.from) / g.speed, 0);

// 書き出しの秒 → 録画の秒（と、その区間の速さ）。
export function toSource(segs: Segment[], outT: number): { t: number; speed: number } {
  let acc = 0;
  for (const g of segs) {
    const len = (g.to - g.from) / g.speed;
    if (outT < acc + len) return { t: g.from + (outT - acc) * g.speed, speed: g.speed };
    acc += len;
  }
  const last = segs[segs.length - 1];
  return { t: last ? last.to : 0, speed: 1 };
}

// 録画の秒 → 書き出しの秒（テロップの位置合わせ用）。
export function toOutput(segs: Segment[], srcT: number): number {
  let acc = 0;
  for (const g of segs) {
    if (srcT < g.from) return acc;
    if (srcT < g.to) return acc + (srcT - g.from) / g.speed;
    acc += (g.to - g.from) / g.speed;
  }
  return acc;
}

// t（ms）以前で最後のフレーム。
export function frameAt(s: Session, tMs: number): string | null {
  const fr = s.frames;
  let lo = 0;
  let hi = fr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (fr[m].t <= tMs) {
      ans = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return ans >= 0 ? fr[ans].f : (fr[0]?.f ?? null);
}

// マウスの位置（CSS px）。move と click の間を線形に補間する。
export function cursorAt(s: Session, tMs: number): { x: number; y: number } | null {
  let prev: { t: number; x: number; y: number } | null = null;
  for (const e of s.events) {
    if (e.type !== "move" && e.type !== "click") continue;
    if (e.t > tMs) {
      if (!prev) return null;
      const k = (tMs - prev.t) / Math.max(1, e.t - prev.t);
      // 間が空いた（ポインタが止まっていた）ときは、動き出す直前まで止めておく。
      if (e.t - prev.t > 300 && tMs < e.t - 300) return prev;
      return { x: prev.x + (e.x - prev.x) * k, y: prev.y + (e.y - prev.y) * k };
    }
    prev = e;
  }
  return prev;
}

export const clicks = (s: Session) =>
  s.events.filter((e): e is Extract<RecEvent, { type: "click" }> => e.type === "click");

// 寄らないクリック（2026-10-02、ホスト指摘「目障り」）:
// - スクロールバー（画面の右端）を掴んだもの
// - 同じ場所を続けて押したもの（プレビューのページ送り等）。押すたびに寄り引きを繰り返すので、連打の一続きは寄らない。
const SCROLLBAR_PX = 24;
const REPEAT_PX = 40;
const REPEAT_S = 10;
function zoomableClicks(s: Session) {
  const cs = clicks(s);
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) <= REPEAT_PX;
  return cs.filter((c, i) => {
    if (c.x >= s.view.width - SCROLLBAR_PX) return false;
    const prev = cs[i - 1];
    const next = cs[i + 1];
    if (prev && near(prev, c) && c.t - prev.t <= REPEAT_S * 1000) return false;
    if (next && near(next, c) && next.t - c.t <= REPEAT_S * 1000) return false;
    return true;
  });
}

// カメラ（寄り）の目標。クリックの少し前から寄り、HOLD 秒そのまま、次の操作が遠ければ引く。
// テロップの zoom 指定があればその間はそれを優先する（1 なら引きで見せる）。
const LEAD = 0.5;
const HOLD = 2.8;
export type Camera = { scale: number; cx: number; cy: number }; // cx, cy は CSS px

export function cameraTarget(s: Session, edit: Edit, srcT: number): Camera {
  const o = opts(edit);
  const full: Camera = { scale: 1, cx: s.view.width / 2, cy: s.view.height / 2 };
  const cap = edit.captions.find((c) => c.zoom !== undefined && srcT >= c.at && srcT < c.at + (c.dur ?? 4));
  if (cap?.zoom === 1) return full;
  const scale = cap?.zoom ?? o.zoom;
  if (scale <= 1) return full;
  if (edit.noZoom?.some(([a, b]) => srcT >= a && srcT < b)) return full;
  let target: Camera | null = null;
  for (const c of zoomableClicks(s)) {
    const ct = c.t / 1000;
    if (ct - LEAD > srcT) break;
    if (srcT - ct < HOLD) target = { scale, cx: c.x, cy: c.y };
  }
  return target ? clampCamera(s, target) : full;
}

// 寄ったときに画面の外が映らないよう中心を寄せる。
export function clampCamera(s: Session, c: Camera): Camera {
  const hw = s.view.width / 2 / c.scale;
  const hh = s.view.height / 2 / c.scale;
  return {
    scale: c.scale,
    cx: Math.min(Math.max(c.cx, hw), s.view.width - hw),
    cy: Math.min(Math.max(c.cy, hh), s.view.height - hh),
  };
}
