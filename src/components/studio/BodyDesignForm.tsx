"use client";

// 体の設計（2026-09-29）: 顔アップ（または上半身）から基準の全身を作る前に、服装・体型・背丈を決める。
// 顔アップだけだと体と服はモデルの想像まかせで候補ごとにばらばらになるため（実測、docs/STATUS.md）。

import {
  BODY_BUILD_CHIPS,
  BODY_HEIGHT_CHIPS,
  BODY_OUTFIT_CHIPS,
  BODY_SHOES_CHIPS,
  type BodyDesign,
  type MainRoute,
  type SceneChip,
} from "@/lib/datasetBuilder";

function ChipRow({
  label,
  chips,
  value,
  onSelect,
}: {
  label: string;
  chips: SceneChip[];
  value: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="w-12 shrink-0 text-[10px] text-muted">{label}</span>
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onSelect(value === c.id ? "" : c.id)}
          title={c.id === "" ? "指定しない（元の画像から推測させます）" : undefined}
          className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
            value === c.id
              ? "border-neon-violet/60 bg-neon-violet/20 text-foreground"
              : "border-border text-muted hover:text-foreground"
          }`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function BodyDesignForm({
  design,
  onChange,
  route,
}: {
  design: BodyDesign;
  onChange: (next: BodyDesign) => void;
  route: MainRoute;
}) {
  const set = (patch: Partial<BodyDesign>) => onChange({ ...design, ...patch });
  const outfitMissing = route === "face" && !design.outfitId && !design.outfitText.trim();
  return (
    <div
      className={`space-y-1.5 rounded-md border px-2 py-2 ${
        outfitMissing ? "border-neon-pink/60 bg-neon-pink/5" : "border-border bg-background/40"
      }`}
    >
      <p className="text-[10px] font-medium text-foreground">
        {route === "face" ? "体と服を決める（服装は必須）" : "写っていない部分の服（任意）"}
      </p>
      <ChipRow
        label="服装"
        chips={BODY_OUTFIT_CHIPS}
        value={design.outfitText.trim() ? "" : design.outfitId}
        onSelect={(id) => set({ outfitId: id, outfitText: "" })}
      />
      <div className="flex items-center gap-1">
        <span className="w-12 shrink-0 text-[10px] text-muted">自由入力</span>
        <input
          type="text"
          value={design.outfitText}
          onChange={(e) => set({ outfitText: e.target.value })}
          placeholder="例: 白いブラウスと紺のプリーツスカート（上下まで書くと揃います）"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted/60"
          maxLength={200}
        />
      </div>
      <ChipRow label="靴" chips={BODY_SHOES_CHIPS} value={design.shoesId ?? ""} onSelect={(id) => set({ shoesId: id })} />
      <ChipRow label="体型" chips={BODY_BUILD_CHIPS} value={design.buildId} onSelect={(id) => set({ buildId: id })} />
      <ChipRow label="背丈" chips={BODY_HEIGHT_CHIPS} value={design.heightId} onSelect={(id) => set({ heightId: id })} />
      <p className="text-[10px] leading-relaxed text-muted/80">
        {route === "face"
          ? "体型・背丈の「おまかせ」は、顔や肩の雰囲気からモデルが想像します（候補ごとに多少ばらつくので、気に入った体つきの候補を選んでください）。"
          : "体型・背丈の「おまかせ」は、写っている上半身から推測します。"}
      </p>
    </div>
  );
}
