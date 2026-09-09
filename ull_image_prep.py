"""
ull_image_prep.py — ULL Studio 共通の入力画像正規化レイヤー（"layer utility" 相当）。

ユーザーがアップロードした *任意* の画像を「モデルに安全に渡せる素性の良い 8bit
RGB 画像」へ変換するための、全 GPU ワーカー共通の関門。

  - Multi-Angle (`modal_angle_worker.py`)  … `_load_ref_image`
  - Cinematic / Wan Animate 2 (`modal_wan_animate_blackwell.py`) … `_write_inputs`

クライアント側の前処理（EXIF 焼き込み・縮小・再エンコード）は **ペイロード削減の
最適化に過ぎず**、正しさの保証はこのモジュールが負う。どのワーカーもサーバー側で
必ずこれを通すこと（CLAUDE.md の方針: 入力の頑健性は必須）。

各 Modal image への添付:
    image = image.add_local_python_source("ull_image_prep")
依存:
    - Pillow            … 全ワーカーに既存（必須）
    - pillow-heif       … HEIC/HEIF（任意 / iPhone 写真対策で実質必須。無ければ HEIC のみ弾く）
    - pillow-avif-plugin … AVIF（任意）

処理段（`normalize_input_image`）:
    1. 全形式デコード      — JPEG/PNG/WebP/TIFF/BMP/GIF・APNG(1フレーム目)/HEIC/AVIF
    2. EXIF 回転を焼き込み  — ImageOps.exif_transpose（スマホ縦写真対策）
    3. ICC → sRGB          — 埋め込みプロファイルがあれば変換（色ズレ防止）
    4. RGB へ平坦化        — CMYK/YCbCr/LAB/パレット/グレー/1bit → RGB、
                             透過（RGBA/LA/P+transparency）は bg 色へアルファ合成、
                             16/32bit → 8bit
    5. サイズ調整          — 長辺 > max_edge で LANCZOS 縮小 /
                             短辺 < min_edge で LANCZOS 拡大 /
                             辺長を multiple の倍数へスナップ
    6. メタデータを落とした PIL.Image (mode="RGB") を返す
"""

from __future__ import annotations

import io
from typing import Tuple

_PLUGINS_REGISTERED = False


def _register_plugins() -> None:
    """HEIC/AVIF プラグインを 1 度だけ登録する。無ければ黙って諦める。"""
    global _PLUGINS_REGISTERED
    if _PLUGINS_REGISTERED:
        return
    _PLUGINS_REGISTERED = True
    try:
        import pillow_heif  # type: ignore

        pillow_heif.register_heif_opener()
        try:
            pillow_heif.register_avif_opener()
        except Exception:
            pass
    except Exception:
        pass
    try:
        import pillow_avif  # noqa: F401  # type: ignore  (import 時に登録される)
    except Exception:
        pass


class ImagePrepError(ValueError):
    """デコード不能など、呼び出し側が HTTP 400 として扱うべき失敗。"""


# --------------------------------------------------------------------------- #
# 内部ヘルパー
# --------------------------------------------------------------------------- #
def _to_srgb(im):
    """埋め込み ICC プロファイルがあれば sRGB へ変換する。失敗しても元 im を返す。"""
    icc = (im.info or {}).get("icc_profile")
    if not icc:
        return im
    try:
        from PIL import ImageCms

        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        dst = ImageCms.createProfile("sRGB")
        out_mode = "RGBA" if ("A" in im.getbands()) else "RGB"
        converted = ImageCms.profileToProfile(im, src, dst, outputMode=out_mode)
        # 変換後は元プロファイルを外す（二重適用防止）。
        converted.info.pop("icc_profile", None)
        return converted
    except Exception:
        return im


def _flatten_to_rgb(im, bg: Tuple[int, int, int]):
    """任意モードの PIL 画像を 8bit RGB へ。透過は bg 色へアルファ合成。"""
    from PIL import Image

    mode = im.mode

    # まず素直な RGB / RGBA へ寄せる。
    if mode == "P":
        im = im.convert("RGBA" if "transparency" in im.info else "RGB")
    elif mode in ("CMYK", "YCbCr", "LAB", "HSV"):
        im = im.convert("RGB")
    elif mode in ("I", "I;16", "I;16B", "I;16L", "I;16N", "F"):
        # 16/32bit → 一旦 8bit グレーへ正規化（点ごとのスケーリングは PIL 任せ）。
        im = im.convert("L")
    elif mode == "1":
        im = im.convert("L")

    if im.mode in ("LA", "La"):
        im = im.convert("RGBA")
    if im.mode == "L":
        im = im.convert("RGB")

    if im.mode == "RGBA":
        canvas = Image.new("RGB", im.size, bg)
        canvas.paste(im, mask=im.split()[-1])
        return canvas
    if im.mode != "RGB":
        im = im.convert("RGB")
    return im


def _resize(im, *, max_edge: int, min_edge: int, multiple: int):
    """長辺 max_edge / 短辺 min_edge / 辺長 multiple 倍数の 3 制約を満たす形へ。

    max と min がアスペクト比の都合で両立しないときは **max を優先**（VRAM 保護）。
    その場合、短辺は min_edge を下回ることがある。
    """
    from PIL import Image

    w, h = im.size
    if w <= 0 or h <= 0:
        raise ImagePrepError(f"degenerate image size {w}x{h}")

    longest = max(w, h)
    shortest = min(w, h)

    scale = 1.0
    if max_edge and longest > max_edge:
        scale = max_edge / longest
    if min_edge and shortest * scale < min_edge:
        scale = min_edge / shortest
    if max_edge and longest * scale > max_edge:  # min 拡大で max を突き破ったら戻す
        scale = max_edge / longest

    tw = max(1, round(w * scale))
    th = max(1, round(h * scale))

    if multiple and multiple > 1:
        tw = max(multiple, int(round(tw / multiple)) * multiple)
        th = max(multiple, int(round(th / multiple)) * multiple)

    if (tw, th) != (w, h):
        im = im.resize((tw, th), Image.LANCZOS)
    return im


# --------------------------------------------------------------------------- #
# 公開 API
# --------------------------------------------------------------------------- #
IMAGE_EXTS = frozenset(
    {
        "jpg", "jpeg", "jfif", "jpe",
        "png", "apng",
        "webp",
        "gif",
        "bmp", "dib",
        "tif", "tiff",
        "heic", "heif", "hif",
        "avif",
        "ico",
    }
)


def looks_like_image(filename: str) -> bool:
    """拡張子だけで「画像ファイルか」をざっくり判定（動画・音声を除外する用途）。"""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext in IMAGE_EXTS


def normalize_input_image(
    raw: bytes,
    *,
    max_edge: int = 1536,
    min_edge: int = 0,
    multiple: int = 16,
    bg: Tuple[int, int, int] = (255, 255, 255),
):
    """任意の画像バイト列 → 正規化済み `PIL.Image.Image`（mode="RGB", 8bit）。

    引数:
        raw:      アップロードされた生バイト列。
        max_edge: 長辺の上限 px（0 で無効）。VRAM / レイテンシ保護。
        min_edge: 短辺の下限 px（0 で無効）。極小サムネの拡大に使う。
        multiple: 出力の辺長をこの倍数へスナップ（Angle=64, ComfyUI 系=16）。
        bg:       透過画像を合成する背景色（既定: 白）。

    例外:
        ImagePrepError — デコード不能 / サイズ異常（呼び出し側で 400 扱い）。
    """
    from PIL import Image, ImageOps

    _register_plugins()

    if not raw:
        raise ImagePrepError("empty image payload")

    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception as exc:  # noqa: BLE001
        raise ImagePrepError(f"could not decode image: {exc}") from exc

    # アニメーション（GIF/APNG/animated WebP）は 1 フレーム目のみ採用。
    if getattr(im, "is_animated", False):
        try:
            im.seek(0)
        except Exception:
            pass

    # 1. EXIF 回転を焼き込み
    try:
        im = ImageOps.exif_transpose(im) or im
    except Exception:
        pass

    # 2. ICC → sRGB（平坦化前に。profileToProfile は RGB/RGBA を扱える）
    im = _to_srgb(im)

    # 3. RGB へ平坦化（透過は bg 合成 / 16bit → 8bit / パレット展開 等）
    im = _flatten_to_rgb(im, bg)

    # 4. サイズ調整
    im = _resize(im, max_edge=max_edge, min_edge=min_edge, multiple=multiple)

    # 5. メタデータ除去（保存時に exif=/icc_profile= を渡さない前提だが info も掃除）
    im.info = {}
    return im


def normalize_to_png_bytes(raw: bytes, **kwargs) -> bytes:
    """`normalize_input_image` の結果を PNG バイト列で返す（ファイル書き出し用）。"""
    im = normalize_input_image(raw, **kwargs)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()
