"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Undo2, Wand2 } from "lucide-react";
import type { DatasetImage } from "@/components/studio/LoraStudioTab.parts";

// 「おまかせで整える」の結果（2026-09-25、ホスト案。docs/STATUS.md 00000000）。
// やったことの要約と、除外した画像の一覧を出す。除外は消さずに脇へ置いてあるので、1 枚ずつでも全部でも戻せる。

export type AutoTidyPhase = "cropping" | "waitingTags" | "done";

export type ExcludedImage = {
  img: DatasetImage;
  caption: string;
  captionJa: string;
  tags: string;
  userCaption: boolean;
  /** 除外した理由（一覧に出す）。 */
  reason: string;
  /** どの「おまかせ」の回で除外したか（元に戻すの単位）。 */
  run: number;
};

export type AutoTidyState = {
  run: number;
  phase: AutoTidyPhase;
  /** この回で切り出して足した画像の id。 */
  cropIds: string[];
  cropDone: number;
  cropTotal: number;
  /** やったことの要約（1 行ずつ）。 */
  log: string[];
  /** 学習回数の均しを、次の描画で（除外が反映されてから）かける印。 */
  repeatsPending: boolean;
};

export const AUTO_TIDY_PANEL_ID = "lora-auto-tidy";

export function AutoTidyPanel({
  state,
  excluded,
  disabled,
  onRestore,
  onUndo,
  nextStep,
}: {
  state: AutoTidyState;
  /** この回で除外した画像。 */
  excluded: ExcludedImage[];
  disabled: boolean;
  /** 1 枚だけ戻す。 */
  onRestore: (id: string) => void;
  /** 全部元に戻す（切り出した画像も消す）。 */
  onUndo: () => void;
  /** 整えた後に次にやること（2026-09-26、ホスト報告「何をすればよいか分からない」）。押すとその場所へ送る。 */
  nextStep?: { label: string; onClick: () => void } | null;
}) {
  const [open, setOpen] = useState(true);
  const running = state.phase !== "done";
  const status =
    state.phase === "cropping"
      ? `足りない構図を切り出しています…（${state.cropDone}/${state.cropTotal || "?"} 枚）`
      : state.phase === "waitingTags"
        ? "切り出した画像の構図を判定しています…（1 分ほど）"
        : "整えました。下の診断で結果を確認してください。";

  return (
    <div id={AUTO_TIDY_PANEL_ID} className="scroll-mt-24 rounded-xl border border-neon-pink/40 bg-neon-pink/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-[11px] font-medium text-neon-pink">
          {running ? <Loader2 size={13} className="shrink-0 animate-spin" /> : <Wand2 size={13} className="shrink-0" />}
          <span className="truncate">おまかせで整える — {status}</span>
        </span>
        <ChevronDown size={14} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          {state.log.length > 0 && (
            <ul className="space-y-0.5 text-[10px] leading-relaxed text-muted">
              {state.log.map((line, i) => (
                <li key={i}>・{line}</li>
              ))}
            </ul>
          )}
          {excluded.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] text-muted">
                除外した画像 {excluded.length} 枚（学習には使いません。消してはいないので、戻したいものは「戻す」）:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {excluded.map((e) => (
                  <div
                    key={e.img.id}
                    title={e.reason}
                    className="flex w-16 flex-col items-center gap-0.5 rounded-md border border-border/60 bg-background/60 p-1"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={e.img.url} alt={e.img.file.name} className="h-12 w-12 rounded object-cover opacity-70" />
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onRestore(e.img.id)}
                      className="text-[9px] text-neon-violet hover:underline disabled:opacity-50"
                    >
                      戻す
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {!running && nextStep && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neon-pink/40 bg-background/60 px-2.5 py-2">
              <span className="text-[11px] font-medium text-foreground">次は: {nextStep.label}</span>
              <button
                type="button"
                onClick={nextStep.onClick}
                className="rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90"
              >
                次へ進む
              </button>
            </div>
          )}
          {!running && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={disabled}
                onClick={onUndo}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10px] text-muted transition-colors hover:text-foreground disabled:opacity-50"
              >
                <Undo2 size={11} />
                すべて元に戻す（切り出した画像も消します）
              </button>
              <span className="text-[10px] text-muted">個別の操作（減らす・切り出す）はこのまま続けて使えます。</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
