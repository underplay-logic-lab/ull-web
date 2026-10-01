import { loadFont } from "@remotion/google-fonts/NotoSansJP";

// サイトと同じ色（src/app/globals.css）。
export const color = {
  background: "#121214",
  foreground: "#ffffff",
  muted: "#a1a1aa",
  pink: "#ff2a85",
  violet: "#8b5cf6",
};

export const { fontFamily } = loadFont("normal", { weights: ["700", "900"] });

export const FPS = 30;
export const sec = (s: number) => Math.round(s * FPS);
