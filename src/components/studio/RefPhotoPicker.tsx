"use client";

// 参照写真の追加欄（2 枚目以降・最大 8 枚）と、写真ごとの使い方（人物／持ち物／場所／画風）。
// Photo Director（2026-10-06）で使う。Director の「顔写真として使う」の欄と同じ見た目・同じ意味。

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Plus, X } from "lucide-react";
import { DIRECTOR_REF_ROLES, type DirectorRefRole } from "@/lib/directorPricing";

export const MAX_EXTRA_REF_PHOTOS = 8;

export type RefPhoto = { file: File; role: DirectorRefRole };

export function RefPhotoPicker({
  value,
  onChange,
  label = "写真を追加（任意）",
}: {
  value: RefPhoto[];
  onChange: (next: RefPhoto[]) => void;
  label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const urls = useMemo(() => value.map((r) => URL.createObjectURL(r.file)), [value]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const add = (files: FileList | File[] | null | undefined) => {
    if (!files) return;
    const list = Array.from(files);
    const ok = list.filter((f) => f.type.startsWith("image/"));
    const room = MAX_EXTRA_REF_PHOTOS - value.length;
    setError(
      ok.length < list.length
        ? "画像ファイル（PNG・JPEG・WebP など）を選んでください。"
        : ok.length > room
          ? `追加できるのは ${MAX_EXTRA_REF_PHOTOS} 枚までです（${ok.length - room} 枚は入れませんでした）。`
          : null,
    );
    if (ok.length && room > 0) onChange([...value, ...ok.slice(0, room).map((file): RefPhoto => ({ file, role: "person" }))]);
  };

  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium text-muted">
        {label}・あと {MAX_EXTRA_REF_PHOTOS - value.length} 枚まで
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
        className={`grid grid-cols-4 gap-2 rounded-xl border border-dashed p-2 transition-colors sm:grid-cols-5 ${
          dragging ? "border-neon-pink/60 bg-neon-pink/5" : "border-border"
        }`}
      >
        {urls.map((u, i) => (
          <div key={u} className="flex flex-col gap-1">
            <div className="relative aspect-square overflow-hidden rounded-lg bg-background">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt={`追加の写真 ${i + 2}`} className="h-full w-full object-contain" />
              {/* プロンプトで指すときの名前（<Picture N>。サーバーが「Picture 2」「2枚目」なども同じタグにそろえる）。 */}
              <span className="absolute left-1 top-1 rounded bg-black/60 px-1 py-px font-mono text-[9px] leading-tight text-white">
                Picture {i + 2}
              </span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="absolute right-1 top-1 rounded bg-black/60 p-0.5 text-white transition-colors hover:bg-black/80"
                aria-label={`追加の写真 ${i + 2} を外す`}
              >
                <X size={12} />
              </button>
            </div>
            <select
              value={value[i]?.role ?? "person"}
              onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, role: e.target.value as DirectorRefRole } : r)))}
              aria-label={`追加の写真 ${i + 2} の使い方`}
              className="w-full rounded-md border border-border bg-surface px-1 py-0.5 text-[10px] text-foreground"
            >
              {DIRECTOR_REF_ROLES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        ))}
        {value.length < MAX_EXTRA_REF_PHOTOS && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-border text-[10px] text-muted transition-colors hover:border-neon-violet/40 hover:text-foreground"
          >
            <Plus size={14} />
            追加・ドロップ
          </button>
        )}
      </div>
      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-red-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
        写真ごとに使い方を選べます。「同じ人物」は角度・表情の違う写真を足すほど本人らしさと細部が保たれます。
        「持ち物」は道具や小物をそのままの形で、「場所」はその景色の中で、「画風」は絵柄や色づかいを合わせます。
        場所の写真は出来上がりの縦横に合わせて中央を切り抜きます。1 枚足すごとに料金が少し上がります。
      </p>
    </div>
  );
}
