"""ULL 自作ノード: MiniMax H3 の動画・音声の潜在に「指定した時間の区間だけ作り直す」ノイズマスクを付ける。

動画の部分修正タブ（2026-10-07〜）で使う。Director ワーカー（modal_wan_animate_blackwell.py）の image に
custom_nodes/ull_time_mask として焼き込む。手元の ComfyUI（D:/ComfyUI2/custom_nodes/ull_video_time_mask）で
成立させた ULLVideoTimeMask をそのまま持ってきて、H3 の音声の潜在用（ULLH3AudioTimeMask）を足したもの。

つなぎ目は潜在の中でなじむ: 区間の外（マスク 0）は元の潜在のまま残り、モデルはそれを見ながら区間（マスク 1）を作る。
境目は fade の分だけ 0〜1 の中間にする。

作り直す区間は start〜end 秒（end=-1 は最後まで）:
  - 以降を作り直す: start=50, end=-1
  - までを作り直す: start=0,  end=3
  - 区間だけ:       start=47, end=55
"""
import torch

# comfy/ldm/minimax/model.py の FRAME_PER_TOKEN（潜在 1 コマが受け持つ画素フレーム。先頭だけ 1）
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
# comfy_extras/nodes_minimax_h3.py の FPS / AUDIO_LATENT_FPS
FPS = 24
AUDIO_LATENT_FPS = 40


def _video_frame_count(latent_t):
    """動画の潜在のコマ数 → 画素フレーム数（nodes_minimax_h3.video_latent_t の逆。17k+5）。"""
    return 5 if latent_t <= 2 else (latent_t - 2) // 5 * 17 + 5


def _fade_outward(m, fade):
    """1 の区間の外側に向けて fade 個ぶん 0〜1 の中間を置く。"""
    idx = torch.nonzero(m).flatten()
    if not len(idx) or not fade:
        return idx
    t = m.shape[0]
    first, last = int(idx[0]), int(idx[-1])
    for i in range(fade):
        v = (fade - i) / (fade + 1)
        for j in (first - 1 - i, last + 1 + i):
            if 0 <= j < t and m[j] == 0:
                m[j] = v
    return idx


class ULLVideoTimeMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "samples": ("LATENT",),
            "regen_start_seconds": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 3600.0, "step": 0.1}),
            "regen_end_seconds": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 3600.0, "step": 0.1,
                                            "tooltip": "-1 なら最後まで"}),
            "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0}),
            "fade_tokens": ("INT", {"default": 1, "min": 0, "max": 20}),
        }}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "apply"
    CATEGORY = "ull/video"

    def apply(self, samples, regen_start_seconds, regen_end_seconds, fps, fade_tokens):
        x = samples["samples"]
        b, c, t, h, w = x.shape
        start_f = regen_start_seconds * fps
        end_f = float("inf") if regen_end_seconds < 0 else regen_end_seconds * fps
        # 各潜在コマが受け持つ画素フレームの区間 [lo, hi) が、作り直す区間と重なれば 1
        m = torch.zeros(t)
        lo = 0
        for k in range(t):
            hi = lo + FRAME_PER_TOKEN[k % 5]
            if hi > start_f and lo < end_f:
                m[k] = 1.0
            lo = hi
        idx = _fade_outward(m, fade_tokens)
        mask = m.view(1, 1, t, 1, 1).expand(1, 1, t, h, w).contiguous()
        out = samples.copy()
        out["noise_mask"] = mask
        rng = (int(idx[0]), int(idx[-1])) if len(idx) else None
        end_txt = "end" if regen_end_seconds < 0 else f"{regen_end_seconds}s"
        print(f"[ULLVideoTimeMask] T={t} regenerate {regen_start_seconds}s-{end_txt} -> latent {rng}", flush=True)
        return (out,)


class ULLH3AudioTimeMask:
    """H3 の音声の潜在 [B, 32, 2, T]（40 コマ/秒）に時間マスクを付ける。

    video_latent を繋ぐと、その動画の長さが要求する T（nodes_minimax_h3.temporal_shape と同じ式）に切り詰め／
    末尾をゼロで埋める（埋めた分はマスク 1＝作る）。LTXVConcatAVLatent は動画側が素の潜在（VAEEncode の出力）だと
    長さを合わせないので、ここで揃える。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "regen_start_seconds": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 3600.0, "step": 0.1}),
                "regen_end_seconds": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 3600.0, "step": 0.1,
                                                "tooltip": "-1 なら最後まで"}),
                "fade_frames": ("INT", {"default": 6, "min": 0, "max": 200,
                                        "tooltip": "40 コマ/秒。6 で約 0.15 秒（動画の 1 コマ分）"}),
            },
            "optional": {"video_latent": ("LATENT",)},
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "apply"
    CATEGORY = "ull/audio"

    def apply(self, samples, regen_start_seconds, regen_end_seconds, fade_frames, video_latent=None):
        x = samples["samples"]
        if x.ndim != 4:
            raise ValueError(f"ULLH3AudioTimeMask expects an H3 audio latent [B,32,2,T], got {tuple(x.shape)}")
        pad = 0
        if video_latent is not None:
            vt = video_latent["samples"].shape[2]
            target = round(_video_frame_count(vt) / FPS * AUDIO_LATENT_FPS)
            if x.shape[-1] > target:
                x = x[..., :target]
            elif x.shape[-1] < target:
                pad = target - x.shape[-1]
                x = torch.cat([x, torch.zeros_like(x[..., :1]).repeat(1, 1, 1, pad)], dim=-1)
        t = x.shape[-1]
        start = max(0, min(t, int(round(regen_start_seconds * AUDIO_LATENT_FPS))))
        end = t if regen_end_seconds < 0 else max(start, min(t, int(round(regen_end_seconds * AUDIO_LATENT_FPS))))
        m = torch.zeros(t)
        m[start:end] = 1.0
        if pad:
            m[t - pad:] = 1.0
        _fade_outward(m, fade_frames)
        out = samples.copy()
        out["samples"] = x
        out["noise_mask"] = m.view(1, 1, 1, t).expand(1, 1, x.shape[2], t).contiguous()
        end_txt = "end" if regen_end_seconds < 0 else f"{regen_end_seconds}s"
        print(f"[ULLH3AudioTimeMask] T={t} (pad {pad}) regenerate {regen_start_seconds}s-{end_txt} -> [{start}, {end})",
              flush=True)
        return (out,)


NODE_CLASS_MAPPINGS = {
    "ULLVideoTimeMask": ULLVideoTimeMask,
    "ULLH3AudioTimeMask": ULLH3AudioTimeMask,
}
