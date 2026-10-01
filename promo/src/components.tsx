import type { CSSProperties } from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Asset } from "./assets";
import { color, fontFamily } from "./theme";

const isVideo = (src: string) => /\.(mp4|webm|mov)$/i.test(src);

// 素材 1 枚分。src が null なら仮の枠を出す。
export function Slot({
  src,
  label,
  style,
  fit = "cover",
  playbackRate = 1,
}: {
  src: Asset;
  label: string;
  style?: CSSProperties;
  fit?: "cover" | "contain";
  playbackRate?: number;
}) {
  const base: CSSProperties = { width: "100%", height: "100%", objectFit: fit, ...style };
  if (!src) return <Placeholder label={label} style={style} />;
  const url = staticFile(src);
  return isVideo(src) ? (
    <OffthreadVideo src={url} style={base} muted={playbackRate !== 1} playbackRate={playbackRate} />
  ) : (
    <Img src={url} style={base} />
  );
}

export function Placeholder({ label, style }: { label: string; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 16,
        boxSizing: "border-box",
        background: `linear-gradient(135deg, ${color.violet}33, ${color.pink}22)`,
        border: `2px dashed ${color.violet}88`,
        color: color.muted,
        fontFamily,
        fontWeight: 700,
        fontSize: 28,
        ...style,
      }}
    >
      {label}
    </div>
  );
}

// テロップ。下からふわっと出る。position で上下を選ぶ。
export function Telop({
  text,
  position = "bottom",
  size = 64,
}: {
  text: string;
  position?: "top" | "center" | "bottom";
  size?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame, fps, config: { damping: 200 } });
  const y = interpolate(p, [0, 1], [30, 0]);
  const justify = position === "top" ? "flex-start" : position === "center" ? "center" : "flex-end";
  return (
    <AbsoluteFill style={{ justifyContent: justify, alignItems: "center", padding: "8% 6%" }}>
      <div
        style={{
          opacity: p,
          transform: `translateY(${y}px)`,
          fontFamily,
          fontWeight: 900,
          fontSize: size,
          lineHeight: 1.3,
          color: color.foreground,
          textAlign: "center",
          whiteSpace: "pre-line",
          textShadow: "0 4px 24px rgba(0,0,0,0.85), 0 0 4px rgba(0,0,0,0.9)",
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
}

// ゆっくり寄る（Ken Burns）。静止画を動いて見せる。
export function SlowZoom({ children, from = 1, to = 1.08 }: { children: React.ReactNode; from?: number; to?: number }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const s = interpolate(frame, [0, durationInFrames], [from, to]);
  return <AbsoluteFill style={{ transform: `scale(${s})` }}>{children}</AbsoluteFill>;
}

export function FadeIn({ children, frames = 8 }: { children: React.ReactNode; frames?: number }) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: interpolate(frame, [0, frames], [0, 1], { extrapolateRight: "clamp" }) }}>{children}</AbsoluteFill>;
}
