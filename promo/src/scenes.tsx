import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { DATASET_TILES, assets, type Asset } from "./assets";
import { FadeIn, Slot, SlowZoom, Telop } from "./components";
import { color, fontFamily, sec } from "./theme";

const Bg = ({ children }: { children: React.ReactNode }) => (
  <AbsoluteFill style={{ background: color.background }}>{children}</AbsoluteFill>
);

// つかみ: 一番映えるカット＋「この子、元は写真 1 枚です」
export function Hook({ telop }: { telop: string }) {
  return (
    <Bg>
      <SlowZoom>
        <Slot src={assets.hero} label="一番映えるカット（寄り・しゃべっている）" />
      </SlowZoom>
      <Sequence from={sec(0.3)} layout="none">
        <Telop text={telop} />
      </Sequence>
    </Bg>
  );
}

// 元の顔 1 枚がドンと出る
export function Source({ telop }: { telop: string }) {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const p = spring({ frame, fps, config: { damping: 14, mass: 0.6 } });
  const size = Math.min(width, height) * 0.62;
  return (
    <Bg>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: size,
            height: size,
            transform: `scale(${interpolate(p, [0, 1], [0.6, 1])})`,
            opacity: p,
            borderRadius: 24,
            overflow: "hidden",
            boxShadow: `0 0 80px ${color.pink}55`,
          }}
        >
          <Slot src={assets.sourceFace} label="元の顔 1 枚" />
        </div>
      </AbsoluteFill>
      <Telop text={telop} position="top" />
    </Bg>
  );
}

// 素材づくりの結果がグリッドで次々に埋まる
export function DatasetGrid({ telop, cols }: { telop: string; cols: number }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fillUntil = durationInFrames * 0.7;
  const tiles: Asset[] = Array.from({ length: DATASET_TILES }, (_, i) => assets.dataset[i] ?? null);
  return (
    <Bg>
      {/* 行数を決めて画面に収める（枚数が多くてもはみ出さない）。 */}
      <AbsoluteFill
        style={{
          padding: "4% 4% 24%",
          boxSizing: "border-box",
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${Math.ceil(DATASET_TILES / cols)}, 1fr)`,
          gap: 6,
        }}
      >
          {tiles.map((src, i) => {
            const at = (i / DATASET_TILES) * fillUntil;
            const o = interpolate(frame, [at, at + 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <div key={i} style={{ minHeight: 0, overflow: "hidden", borderRadius: 6, opacity: o, transform: `scale(${0.8 + 0.2 * o})` }}>
                <Slot src={src} label={String(i + 1)} style={{ fontSize: 18, padding: 4 }} />
              </div>
            );
          })}
      </AbsoluteFill>
      <Telop text={telop} />
    </Bg>
  );
}

// 少し遅れてふわっと出す。Sequence で遅らせると出るまで枠ごと消えて並びがずれるので、透明度だけで出す。
function Appear({ delay, children, style }: { delay: number; children: React.ReactNode; style?: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const o = interpolate(frame, [delay, delay + 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <div style={{ position: "relative", opacity: o, ...style }}>{children}</div>;
}

// 基準の全身像・真横・後ろ姿（横型の 2 段目）
export function BaseViews({ telop }: { telop: string }) {
  const labels = ["基準の全身像", "真横", "後ろ姿"];
  return (
    <Bg>
      <AbsoluteFill style={{ flexDirection: "row", gap: 24, padding: "6% 8% 18%", boxSizing: "border-box" }}>
        {labels.map((l, i) => (
          <Appear key={l} delay={i * sec(0.6)} style={{ flex: 1, borderRadius: 16, overflow: "hidden" }}>
            <Slot src={assets.baseViews[i] ?? null} label={l} fit="contain" />
          </Appear>
        ))}
      </AbsoluteFill>
      <Telop text={telop} />
    </Bg>
  );
}

// 途中の版ごとの比較
export function StepCompare({ telop, vertical }: { telop: string; vertical: boolean }) {
  return (
    <Bg>
      <AbsoluteFill
        style={{
          display: "grid",
          gridTemplateColumns: vertical ? "1fr 1fr" : `repeat(${assets.steps.length}, 1fr)`,
          gridTemplateRows: vertical ? "1fr 1fr" : "1fr",
          gap: 16,
          padding: vertical ? "24% 5% 8%" : "6% 4% 20%",
          boxSizing: "border-box",
        }}
      >
        {assets.steps.map((s, i) => (
          <Appear key={s.label} delay={i * sec(0.4)} style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
            <div style={{ flex: 1, borderRadius: 12, overflow: "hidden", minHeight: 0 }}>
              <Slot src={s.src} label={s.label} />
            </div>
            <div style={{ fontFamily, fontWeight: 700, fontSize: 30, color: color.muted, textAlign: "center" }}>{s.label}</div>
          </Appear>
        ))}
      </AbsoluteFill>
      <Telop text={telop} position={vertical ? "top" : "bottom"} />
    </Bg>
  );
}

// 場面違いの動画を順に流す。each は 1 本あたりの秒数
export function ClipMontage({ telop, each, count }: { telop: string; each: number; count: number }) {
  const clips = assets.clips.slice(0, count);
  return (
    <Bg>
      {clips.map((c, i) => (
        <Sequence key={c.label} from={i * sec(each)} durationInFrames={sec(each)}>
          <FadeIn frames={4}>
            <Slot src={c.src} label={c.label} />
          </FadeIn>
        </Sequence>
      ))}
      <Telop text={telop} />
    </Bg>
  );
}

// 操作画面の録画を早送りで見せる
export function Screen({ telop, src, label }: { telop: string; src: Asset; label: string }) {
  return (
    <Bg>
      <AbsoluteFill style={{ padding: "4% 6% 16%", boxSizing: "border-box" }}>
        <div style={{ width: "100%", height: "100%", borderRadius: 16, overflow: "hidden", border: `1px solid ${color.violet}55` }}>
          <Slot src={src} label={label} fit="contain" playbackRate={4} />
        </div>
      </AbsoluteFill>
      <Telop text={telop} />
    </Bg>
  );
}

// 動画超解像の使用前・使用後（左右をワイプ）
export function UpscaleCompare({ telop }: { telop: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const x = interpolate(frame, [0, durationInFrames * 0.4, durationInFrames * 0.8], [90, 10, 50], { extrapolateRight: "clamp" });
  return (
    <Bg>
      <Slot src={assets.upscaleAfter} label="使用後" />
      <AbsoluteFill style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }}>
        <Slot src={assets.upscaleBefore} label="使用前" style={{ background: "#2a2a30" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ left: `${x}%`, width: 4, background: color.foreground }} />
      <Telop text={telop} />
    </Bg>
  );
}

// 締め: ロゴと URL
export function Outro({ tagline }: { tagline: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame, fps, config: { damping: 200 } });
  return (
    <Bg>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 24, opacity: p, fontFamily }}>
        <div
          style={{
            fontWeight: 900,
            fontSize: 120,
            background: `linear-gradient(90deg, ${color.pink}, ${color.violet})`,
            WebkitBackgroundClip: "text",
            color: "transparent",
          }}
        >
          ULL Studio
        </div>
        <div style={{ fontWeight: 700, fontSize: 44, color: color.foreground }}>{tagline}</div>
        <div style={{ fontWeight: 700, fontSize: 40, color: color.muted }}>www.ullstudio.com</div>
      </AbsoluteFill>
    </Bg>
  );
}
