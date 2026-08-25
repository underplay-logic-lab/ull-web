"use client";

import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { useSiteContentEditor } from "@/components/SiteContentEditorProvider";

type PublicAsset = { path: string; size: number };

type EditableMediaProps = {
  // site_contents key holding the media URL.
  siteKey: string;
  kind: "image" | "video";
  // "" means "no media" — outside edit mode, an unset EditableMedia
  // renders nothing at all rather than a broken/placeholder image.
  fallback?: string;
  alt?: string;
  className?: string;
};

// Inline image/video replacement for the Visual Editor. Outside edit mode
// it's a plain <img>/<video> (or nothing, if unset). In edit mode, hovering
// reveals a "📷 メディアを変更" overlay; clicking opens a popup to paste a
// URL or pick a file already under public/ — applied to the shared draft
// state, published later from AdminEditBar's bar like every other edit.
export function EditableMedia({ siteKey, kind, fallback = "", alt = "", className }: EditableMediaProps) {
  const { editMode, publishing, getValue, setDraft } = useSiteContentEditor();
  const [popupOpen, setPopupOpen] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [assets, setAssets] = useState<PublicAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const url = getValue(siteKey, fallback);

  useEffect(() => {
    if (!popupOpen) return;
    let cancelled = false;
    (async () => {
      setAssetsLoading(true);
      try {
        const res = await fetch("/api/admin/public-assets");
        const data = await res.json();
        if (!cancelled && res.ok) setAssets(data.assets as PublicAsset[]);
      } catch (err) {
        console.error("[EditableMedia] failed to load public assets:", err);
      } finally {
        if (!cancelled) setAssetsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [popupOpen]);

  if (!editMode) {
    if (!url) return null;
    return kind === "image" ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={alt} className={className} />
    ) : (
      <video src={url} className={className} muted loop autoPlay playsInline />
    );
  }

  const openPopup = () => {
    setDraftUrl(url);
    setPopupOpen(true);
  };

  const applyUrl = (nextUrl: string) => {
    setDraft(siteKey, nextUrl.trim());
    setPopupOpen(false);
  };

  return (
    <div className={`group relative ${className ?? ""}`}>
      {url ? (
        kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={alt} className="h-full w-full object-cover" />
        ) : (
          <video src={url} className="h-full w-full object-cover" muted loop autoPlay playsInline />
        )
      ) : (
        <div className="flex min-h-[120px] w-full items-center justify-center rounded-xl border border-dashed border-border bg-background/60 text-xs text-muted">
          未設定（クリックして{kind === "image" ? "画像" : "動画"}を追加）
        </div>
      )}

      <button
        type="button"
        onClick={openPopup}
        disabled={publishing}
        className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/60 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:cursor-not-allowed"
      >
        📷 メディアを変更
      </button>

      {popupOpen && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
          onClick={() => setPopupOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border-gradient bg-surface p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">メディアを変更</span>
              <button
                type="button"
                onClick={() => setPopupOpen(false)}
                aria-label="閉じる"
                className="text-muted transition-colors hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            <label className="mb-1.5 block text-xs font-medium text-muted">
              URL（外部URL または public/ 内のパス）
            </label>
            <input
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="/mock/example.png または https://..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-neon-violet/50"
            />

            <div className="mt-3 max-h-48 overflow-y-auto rounded-lg border border-border">
              {assetsLoading ? (
                <p className="p-3 text-center text-xs text-muted">読み込み中...</p>
              ) : assets.length === 0 ? (
                <p className="p-3 text-center text-xs text-muted">public/ 内にメディアが見つかりません。</p>
              ) : (
                assets.map((asset) => (
                  <button
                    key={asset.path}
                    type="button"
                    onClick={() => setDraftUrl(asset.path)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                  >
                    <span className="truncate font-mono">{asset.path}</span>
                    <span className="shrink-0 text-[10px] opacity-60">{(asset.size / 1024).toFixed(0)}KB</span>
                  </button>
                ))
              )}
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => applyUrl("")}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-muted transition-colors hover:border-red-400/40 hover:text-red-400"
              >
                <Trash2 size={12} />
                削除
              </button>
              <button
                type="button"
                onClick={() => applyUrl(draftUrl)}
                className="flex-1 rounded-lg bg-gradient-to-r from-neon-pink to-neon-violet px-3 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
              >
                適用（下部バーで公開）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
