import { Composition, Series } from "remotion";
import { assets } from "./assets";
import { BaseViews, ClipMontage, DatasetGrid, Hook, Outro, Screen, Source, StepCompare, UpscaleCompare } from "./scenes";
import { FPS, sec } from "./theme";

// 尺は docs/promo-video-storyboard.md の表に合わせる。秒を変えたら合計（durationInFrames）も揃うよう total() で数える。
type Part = { s: number; el: React.ReactNode };
const total = (parts: Part[]) => sec(parts.reduce((a, p) => a + p.s, 0));
const render = (parts: Part[]) => (
  <Series>
    {parts.map((p, i) => (
      <Series.Sequence key={i} durationInFrames={sec(p.s)}>
        {p.el}
      </Series.Sequence>
    ))}
  </Series>
);

// A. 縦型ショート（9:16・30 秒）
const SHORT_CLIP_EACH = 3;
const shortParts: Part[] = [
  { s: 2, el: <Hook telop={"この子、元は\n写真 1 枚です"} /> },
  { s: 2, el: <Source telop="1 枚だけ" /> },
  { s: 5, el: <DatasetGrid cols={5} telop={"角度も服も場所も\nぜんぶ作る"} /> },
  { s: 3, el: <StepCompare vertical telop={"その子だけを\n覚えさせる"} /> },
  { s: SHORT_CLIP_EACH * 4, el: <ClipMontage each={SHORT_CLIP_EACH} count={4} telop={"どこでも、同じ子"} /> },
  { s: 4, el: <Hook telop="" /> },
  { s: 2, el: <Outro tagline="写真 1 枚から、動いてしゃべる" /> },
];

// B. 横型紹介（16:9・90 秒）
const LAND_CLIP_EACH = 7;
const landscapeParts: Part[] = [
  { s: 5, el: <Hook telop="この子、元は写真 1 枚です" /> },
  { s: 3, el: <Source telop="用意するのは顔 1 枚だけ" /> },
  { s: 5, el: <BaseViews telop="横顔も後ろ姿も、手元に無くていい" /> },
  { s: 5, el: <Screen src={assets.screenDataset} label="素材づくりの操作画面（録画・早送り）" telop="場面・服・角度を選ぶだけ" /> },
  { s: 7, el: <DatasetGrid cols={9} telop="LoRA 用の素材が一式そろう" /> },
  { s: 6, el: <Screen src={assets.screenLora} label="LoRA Studio の操作画面（録画・早送り）" telop="そのまま学習へ" /> },
  { s: 9, el: <StepCompare vertical={false} telop="途中の版もぜんぶ受け取れる" /> },
  { s: LAND_CLIP_EACH * 5, el: <ClipMontage each={LAND_CLIP_EACH} count={5} telop="どんな場面でも、同じ子が動く" /> },
  { s: 10, el: <UpscaleCompare telop="仕上げに高画質化も" /> },
  { s: 5, el: <Outro tagline="要望で育つ、生成スタジオ" /> },
];

export const Root = () => (
  <>
    <Composition
      id="Short"
      component={() => render(shortParts)}
      durationInFrames={total(shortParts)}
      fps={FPS}
      width={1080}
      height={1920}
    />
    <Composition
      id="Landscape"
      component={() => render(landscapeParts)}
      durationInFrames={total(landscapeParts)}
      fps={FPS}
      width={1920}
      height={1080}
    />
  </>
);
