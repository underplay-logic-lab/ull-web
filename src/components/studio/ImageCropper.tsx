"use client";

import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import Cropper, { type Area } from "react-easy-crop";
import { Check, X, ZoomIn } from "lucide-react";
import {
  CINEMATIC_ASPECT_RATIOS,
  type CinematicAspectRatio,
} from "@/lib/cinematicPricing";
import { getCroppedImageBlob } from "@/lib/imageCanvas";

type ImageCropperProps = {
  open: boolean;
  imageUrl: string | null;
  initialAspect?: CinematicAspectRatio;
  onCancel: () => void;
  onConfirm: (result: { blob: Blob; aspect: CinematicAspectRatio }) => void;
};

// Full-screen crop step for the Cinematic Video tab — forces the user to
// pick a framing (aspect ratio + position/zoom) and press "確定" before an
// uploaded image can be used, so no arbitrary-aspect-ratio image ever
// reaches the backend unprocessed.
export function ImageCropper({ open, imageUrl, initialAspect = "16:9", onCancel, onConfirm }: ImageCropperProps) {
  const [aspect, setAspect] = useState<CinematicAspectRatio>(initialAspect);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [confirming, setConfirming] = useState(false);

  const aspectRatioValue = useMemo(
    () => CINEMATIC_ASPECT_RATIOS.find((a) => a.id === aspect)?.ratio ?? 16 / 9,
    [aspect],
  );

  const handleCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const handleSelectAspect = (next: CinematicAspectRatio) => {
    setAspect(next);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  };

  const handleConfirm = async () => {
    if (!imageUrl || !croppedAreaPixels || confirming) return;
    setConfirming(true);
    try {
      const blob = await getCroppedImageBlob(imageUrl, croppedAreaPixels);
      onConfirm({ blob, aspect });
    } catch (err) {
      console.error("[ImageCropper] crop failed:", err);
      alert(err instanceof Error ? err.message : "画像のクロップに失敗しました。");
    } finally {
      setConfirming(false);
    }
  };

  if (!open || !imageUrl || typeof document === "undefined") return null;

  return createPortal(
    <div
      data-source-file="src/components/studio/ImageCropper.tsx"
      className="fixed inset-0 z-[110] flex flex-col bg-black/90 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <h3 className="text-sm font-semibold text-white">画像をクロップ</h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="閉じる"
          className="rounded-full p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X size={18} />
        </button>
      </div>

      <div className="relative flex-1">
        <Cropper
          image={imageUrl}
          crop={crop}
          zoom={zoom}
          aspect={aspectRatioValue}
          onCropChange={setCrop}
          onZoomChange={setZoom}
          onCropComplete={handleCropComplete}
        />
      </div>

      <div className="flex flex-col gap-4 border-t border-white/10 bg-black/60 px-6 py-4">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {CINEMATIC_ASPECT_RATIOS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => handleSelectAspect(a.id)}
              className={`rounded-full border px-4 py-1.5 text-xs font-mono font-medium transition-colors ${
                aspect === a.id
                  ? "border-neon-pink/50 bg-neon-pink/15 text-neon-pink"
                  : "border-white/15 text-white/70 hover:border-white/30 hover:text-white"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>

        <div className="mx-auto flex w-full max-w-sm items-center gap-3">
          <ZoomIn size={16} className="shrink-0 text-white/60" />
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="w-full accent-neon-pink"
            aria-label="ズーム"
          />
        </div>

        <button
          type="button"
          onClick={handleConfirm}
          disabled={!croppedAreaPixels || confirming}
          className="mx-auto flex items-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-8 py-3 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check size={16} />
          {confirming ? "処理中..." : "確定"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
