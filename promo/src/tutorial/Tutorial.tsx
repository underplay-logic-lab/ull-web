import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { CalculateMetadataFunction } from "remotion";
import { color, fontFamily } from "../theme";
import {
  type Camera,
  type Edit,
  type Segment,
  type Session,
  buildSegments,
  cameraTarget,
  clicks,
  cursorAt,
  frameAt,
  outLength,
  toOutput,
  toSource,
} from "./timeline";

// 操作動画（docs/promo-video-storyboard.md C）。録画は public/rec/<session>/（scripts/record.mjs）。
export type TutorialProps = {
  session: string;
  data?: { s: Session; edit: Edit; segs: Segment[] };
};

const TITLE_SEC = 2.5;

export const calculateTutorialMetadata: CalculateMetadataFunction<TutorialProps> = async ({ props }) => {
  const base = `rec/${props.session}`;
  const s: Session = await fetch(staticFile(`${base}/session.json`)).then((r) => r.json());
  const edit: Edit = await fetch(staticFile(`${base}/edit.json`))
    .then((r) => (r.ok ? r.json() : { captions: [] }))
    .catch(() => ({ captions: [] }));
  edit.captions = [...(edit.captions ?? [])].filter((c) => c.text).sort((a, b) => a.at - b.at);
  const segs = buildSegments(s, edit);
  const fps = 30;
  return { durationInFrames: Math.max(1, Math.ceil(outLength(segs) * fps)), fps, props: { ...props, data: { s, edit, segs } } };
};

export function Tutorial({ session, data }: TutorialProps) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  if (!data) return null;
  const { s, edit, segs } = data;
  const outT = frame / fps;
  const { t: srcT, speed } = toSource(segs, outT);
  const img = frameAt(s, srcT * 1000);
  const k = width / s.view.width; // CSS px → 書き出し px

  // カメラは前後 ±8 フレームの平均で滑らかにする（毎フレーム純関数で計算できるのでレンダーが並列でも揃う）。
  const W = 8;
  const acc: Camera = { scale: 0, cx: 0, cy: 0 };
  for (let i = -W; i <= W; i++) {
    const c = cameraTarget(s, edit, toSource(segs, Math.max(0, outT + i / fps)).t);
    acc.scale += c.scale;
    acc.cx += c.cx;
    acc.cy += c.cy;
  }
  const n = 2 * W + 1;
  const cam = { scale: acc.scale / n, cx: acc.cx / n, cy: acc.cy / n };
  const tx = (s.view.width / 2 - cam.cx * cam.scale) * k;
  const ty = (s.view.height / 2 - cam.cy * cam.scale) * k;
  const toScreen = (x: number, y: number) => ({ x: tx + x * cam.scale * k, y: ty + y * cam.scale * k });

  const cursor = cursorAt(s, srcT * 1000);
  const ripple = clicks(s).find((c) => srcT * 1000 - c.t >= 0 && srcT * 1000 - c.t < 450);

  const caption = edit.captions.find((c, i) => {
    const from = toOutput(segs, c.at);
    const next = edit.captions[i + 1];
    const until = Math.min(from + (c.dur ?? 6), next ? toOutput(segs, next.at) : Infinity);
    return outT >= from && outT < until;
  });

  return (
    <AbsoluteFill style={{ background: color.background }}>
      <AbsoluteFill
        style={{
          transformOrigin: "0 0",
          transform: `translate(${tx}px, ${ty}px) scale(${cam.scale})`,
        }}
      >
        {img && <Img src={staticFile(`rec/${session}/frames/${img}`)} style={{ width: s.view.width * k, height: s.view.height * k }} />}
      </AbsoluteFill>

      {cursor && <Cursor {...toScreen(cursor.x, cursor.y)} />}
      {ripple && <Ripple {...toScreen(ripple.x, ripple.y)} age={(srcT * 1000 - ripple.t) / 450} />}

      {speed > 1.5 && <FastForward speed={speed} />}
      {caption && <CaptionBar key={caption.at} text={caption.text} />}
      {edit.title && outT < TITLE_SEC && <TitleCard text={edit.title} outT={outT} />}
    </AbsoluteFill>
  );
}

function Cursor({ x, y }: { x: number; y: number }) {
  return (
    <svg width={34} height={34} viewBox="0 0 24 24" style={{ position: "absolute", left: x - 4, top: y - 2, filter: "drop-shadow(0 2px 4px rgba(0,0,0,.6))" }}>
      <path d="M4 2 L4 19 L8.5 14.8 L11.6 21.6 L14.4 20.4 L11.3 13.7 L17.5 13.7 Z" fill="#fff" stroke="#111" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

function Ripple({ x, y, age }: { x: number; y: number; age: number }) {
  const r = interpolate(age, [0, 1], [10, 46]);
  return (
    <div
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: "50%",
        border: `4px solid ${color.pink}`,
        opacity: 1 - age,
      }}
    />
  );
}

function FastForward({ speed }: { speed: number }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 36,
        right: 40,
        padding: "10px 22px",
        borderRadius: 999,
        background: "rgba(0,0,0,.7)",
        color: color.foreground,
        fontFamily,
        fontWeight: 700,
        fontSize: 30,
      }}
    >
      ▶▶ 早送り ×{Math.round(speed)}
    </div>
  );
}

function CaptionBar({ text }: { text: string }) {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 56 }}>
      <div
        style={{
          opacity: p,
          transform: `translateY(${(1 - p) * 20}px)`,
          maxWidth: "80%",
          padding: "18px 36px",
          borderRadius: 18,
          background: "rgba(18,18,20,.88)",
          borderLeft: `8px solid ${color.pink}`,
          color: color.foreground,
          fontFamily,
          fontWeight: 700,
          fontSize: 44,
          lineHeight: 1.4,
          whiteSpace: "pre-line",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}

function TitleCard({ text, outT }: { text: string; outT: number }) {
  const o = interpolate(outT, [0, 0.3, TITLE_SEC - 0.5, TITLE_SEC], [0, 1, 1, 0]);
  return (
    <AbsoluteFill style={{ background: `rgba(18,18,20,${0.85 * o})`, justifyContent: "center", alignItems: "center" }}>
      <div style={{ opacity: o, fontFamily, fontWeight: 900, fontSize: 84, color: color.foreground, whiteSpace: "pre-line", textAlign: "center" }}>
        {text}
      </div>
    </AbsoluteFill>
  );
}
