"""
WorldGen worker on Modal — 画像・文章から 360 度パノラマを作り、3DGS（.ply）にする（2026-10-10 試作・許可制の限定公開を想定）。

目的: 漫画の背景で「どの視点から見ても同じ場所に同じ冷蔵庫がある」部屋を作る（お客さん＝AI 漫画家の要望 2）。
手元の 5070 Ti（16GB）では FLUX を 8bit にしないと載らず、出来も悪かった（色が抜ける・入れた部屋の雰囲気が残らない）。
8bit のせいかを切り分けるため、ここでは bf16 のまま RTX PRO 6000 で回す。

採用（CLAUDE.md §5、docs/model-licenses.md）:
  - WorldGen（`ZiYang-xie/WorldGen`・Apache-2.0、コミット固定）・作者の LoRA `LeoXie/WorldGen`（Apache-2.0）
  - 奥行き DA-2（`haodongli/DA-2`・Apache-2.0）・切り分け OneFormer ADE20k（MIT）・穴埋め LaMa（Apache-2.0）
  - ⚠️ パノラマ: FLUX.1-dev／FLUX.1-Fill-dev（非商用）。許可制の限定公開としてホストがリスク許容（2026-10-10）。
  - 実験的な ml-sharp（Apple）は使わない。圧縮版 FLUX（nunchaku）も使わない（bf16）。
ComfyUI を使わないワーカーなので、Python・torch は WorldGen の推奨に合わせる（CLAUDE.md §1 の例外: WorldGen は Python 3.11 で検証）。

  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_worldgen_worker.py::probe       # CPU: import の確認
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_worldgen_worker.py::precache    # CPU: 重みを Volume の HF キャッシュへ
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_worldgen_worker.py::main --mode t2s --prompt "..." --out-dir <dir>
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_worldgen_worker.py::main --mode i2s --image room.png --out-dir <dir>
"""

import io
import os
import pathlib
import time

import fastapi
import modal

app = modal.App("ull-worldgen")
MODELS_DIR = "/models"
HF_HOME = f"{MODELS_DIR}/worldgen/hf_home"
vol = modal.Volume.from_name("ull-wan-models")
GPU = os.environ.get("WORLDGEN_GPU", "RTX-PRO-6000")

WORLDGEN_COMMIT = "7ce7b2767fdf31e2727b69a2e61e2e950e3a017f"  # 2026-04-12（手元の試験と同じ）
DA2_REPO = "https://github.com/EnVision-Research/DA-2.git"
UTILS3D_COMMIT = "3913c65d81e05e47b9f367250cf8c0f7462a0900"
# Volume に置く HF のリポジトリ（FLUX は 1 ファイルにまとめた版を除く。WorldGen は Diffusers のフォルダ構成を読む）。
# 生成の解像度（パノラマの横幅。縦はその半分）。1600 だと 90 度の切り出しが元 400px で、1920 に引き伸ばすとぼやけた（2026-10-10）。
PANO_GEN_WIDTH = 2048
# 左右の端をつなぐときに混ぜる幅（潜在の列。1 列＝8px）。作者の既定 6（48px）だと境目に段差が残った。24 に広げても、
# 混ぜる処理の終わる位置に段差と二重の物が出た（2026-10-10）→ 生成は既定に戻し、継ぎ目は出来上がってから FLUX Fill で描き直す（_fix_seam）。
PANO_BLEND_EXTEND = 0
PANO_STEPS = 50
# 継ぎ目（2026-10-10）: 最初から毎 step 半周回すと形が決まる前から回るので部屋が曲線に。1 回だけ回すと、回した後の端が新しい継ぎ目になり、
# 元の向きに戻すと正面に来た。→ 形が決まるまで（PANO_ROLL_AT step）は回さず、その後は毎 step 半周回す（決まった場所に継ぎ目が居座らない）。
PANO_ROLL_AT = int(os.environ.get("WORLDGEN_ROLL_AT", "15"))
# 継ぎ目（2026-10-10）: 後から帯を描き直す方法は、FLUX Fill は別の部屋を描き、LaMa は縦の筋が残って不可。
# → 文章から作るときは、描いている途中で 1 step ごとに潜在を半周回す（左右の端が交互に真ん中に来て、つながった絵として描かれる）。
#   50 step（偶数回）なので最後は元の向きに戻る。作者の「端だけ混ぜる」処理（blend_extend）は使わない（0）。
# 超解像（Real-ESRGAN x4plus・BSD-3-Clause、`xinntao/Real-ESRGAN` v0.1.0、2026-10-10 確認）。2048 → 8192。左右は輪つなぎで処理する。
# 重みは超解像タブ（modal_seedvr2_worker の動画の安いタイプ）と同じファイルを共有する（同じ RealESRGAN_x4plus・63.9MiB）。
ESRGAN_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
ESRGAN_PATH = f"{MODELS_DIR}/upscale_models/RealESRGAN_x4plus.pth"
HF_REPOS = [
    ("black-forest-labs/FLUX.1-dev", ["flux1-dev.safetensors"]),
    ("black-forest-labs/FLUX.1-Fill-dev", ["flux1-fill-dev.safetensors"]),
    ("LeoXie/WorldGen", []),
    ("haodongli/DA-2", []),
    ("shi-labs/oneformer_ade20k_swin_large", []),
]

_SHIM_TRANSFORMS = r'''
"""pytorch3d.transforms のうち WorldGen（splat_utils）が使う関数だけの代わり（本物は組み立てが重い）。戻り値は (w, x, y, z)。"""
import torch
import torch.nn.functional as F


def _sqrt_positive_part(x):
    ret = torch.zeros_like(x)
    pos = x > 0
    ret[pos] = torch.sqrt(x[pos])
    return ret


def matrix_to_quaternion(matrix):
    batch_dim = matrix.shape[:-2]
    m00, m01, m02, m10, m11, m12, m20, m21, m22 = torch.unbind(matrix.reshape(batch_dim + (9,)), dim=-1)
    q_abs = _sqrt_positive_part(torch.stack([1.0 + m00 + m11 + m22, 1.0 + m00 - m11 - m22, 1.0 - m00 + m11 - m22, 1.0 - m00 - m11 + m22], dim=-1))
    quat_by_rijk = torch.stack([
        torch.stack([q_abs[..., 0] ** 2, m21 - m12, m02 - m20, m10 - m01], dim=-1),
        torch.stack([m21 - m12, q_abs[..., 1] ** 2, m10 + m01, m02 + m20], dim=-1),
        torch.stack([m02 - m20, m10 + m01, q_abs[..., 2] ** 2, m12 + m21], dim=-1),
        torch.stack([m10 - m01, m20 + m02, m21 + m12, q_abs[..., 3] ** 2], dim=-1),
    ], dim=-2)
    flr = torch.tensor(0.1).to(dtype=q_abs.dtype, device=q_abs.device)
    quat_candidates = quat_by_rijk / (2.0 * q_abs[..., None].max(flr))
    out = quat_candidates[F.one_hot(q_abs.argmax(dim=-1), num_classes=4) > 0.5, :].reshape(batch_dim + (4,))
    return torch.where(out[..., 0:1] < 0, -out, out)


def quaternion_to_matrix(q):
    r, i, j, k = torch.unbind(q, -1)
    two_s = 2.0 / (q * q).sum(-1)
    o = torch.stack((1 - two_s * (j * j + k * k), two_s * (i * j - k * r), two_s * (i * k + j * r),
                     two_s * (i * j + k * r), 1 - two_s * (i * i + k * k), two_s * (j * k - i * r),
                     two_s * (i * k - j * r), two_s * (j * k + i * r), 1 - two_s * (i * i + j * j)), -1)
    return o.reshape(q.shape[:-1] + (3, 3))
'''
_SHIM_NUNCHAKU = '''
class NunchakuFluxTransformer2dModel:
    @classmethod
    def from_pretrained(cls, *a, **k):
        raise RuntimeError("nunchaku is not installed (use low_vram=False)")
'''


def _write_shims():
    """nunchaku（圧縮版 FLUX・使わない）と pytorch3d（使う関数 1 つ）の代わりを site-packages に置く。"""
    import site

    sp = pathlib.Path(site.getsitepackages()[0])
    (sp / "pytorch3d").mkdir(exist_ok=True)
    (sp / "pytorch3d" / "__init__.py").write_text("")
    (sp / "pytorch3d" / "transforms.py").write_text(_SHIM_TRANSFORMS)
    for d in ["nunchaku", "nunchaku/lora", "nunchaku/lora/flux"]:
        (sp / d).mkdir(parents=True, exist_ok=True)
    (sp / "nunchaku" / "__init__.py").write_text(_SHIM_NUNCHAKU)
    (sp / "nunchaku" / "utils.py").write_text("def get_precision():\n    raise RuntimeError('nunchaku is not installed')\n")
    (sp / "nunchaku" / "lora" / "__init__.py").write_text("")
    (sp / "nunchaku" / "lora" / "flux" / "__init__.py").write_text("")
    (sp / "nunchaku" / "lora" / "flux" / "compose.py").write_text("def compose_lora(*a, **k):\n    raise RuntimeError('nunchaku is not installed')\n")


image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0", "libgomp1", "libegl1", "libx11-6", "libusb-1.0-0", "libxrender1", "libxext6", "libsm6")
    .pip_install("torch==2.8.0", "torchvision==0.23.0", index_url="https://download.pytorch.org/whl/cu128")
    .pip_install(
        "diffusers>=0.33.1,<0.40", "transformers>=4.48.3,<5", "py360convert", "einops", "pillow", "scikit-image", "sentencepiece",
        "opencv-python-headless", "peft>=0.7.1", "open3d", "trimesh", "timm", "accelerate", "safetensors", "protobuf", "matplotlib",
        "huggingface_hub[hf_transfer]", "requests", "loguru", "fastapi[standard]", "boto3>=1.35", "spandrel>=0.4",
        f"git+https://github.com/EasternJournalist/utils3d.git@{UTILS3D_COMMIT}",
    )
    .run_commands(
        f"pip install --no-deps 'git+{DA2_REPO}#subdirectory=src'",
        # iopaint は古い diffusers を指定していてぶつかる。使うのは LaMa の重みを落として読む iopaint.helper だけなので依存なしで入れる。
        "pip install --no-deps iopaint==1.6.0",
        f"git clone https://github.com/ZiYang-xie/WorldGen.git /root/WorldGen && cd /root/WorldGen && git checkout {WORLDGEN_COMMIT}",
        "pip install --no-deps -e /root/WorldGen",
    )
    .run_function(_write_shims)
    .env({"HF_HOME": HF_HOME, "HF_HUB_ENABLE_HF_TRANSFER": "1", "PYTHONUNBUFFERED": "1"})
    .add_local_python_source("ull_gpu_monitor", "ull_r2")
)


@app.function(image=image, cpu=2, memory=8192, timeout=600, scaledown_window=2, volumes={MODELS_DIR: vol})
def probe() -> dict:
    """GPU なしで確かめる: torch と WorldGen の import・重みの有無。"""
    import torch
    from huggingface_hub import scan_cache_dir

    import worldgen  # noqa: F401
    from worldgen import WorldGen  # noqa: F401

    have = {}
    try:
        for r in scan_cache_dir(f"{HF_HOME}/hub").repos:
            have[r.repo_id] = round(r.size_on_disk / 1e9, 2)
    except Exception as exc:  # noqa: BLE001
        have["error"] = str(exc)
    out = {"torch": torch.__version__, "cuda_build": torch.version.cuda, "worldgen": "import ok", "hf_cache_gb": have}
    print(out, flush=True)
    return out


@app.function(image=image, cpu=4, memory=16384, timeout=3 * 3600, scaledown_window=2, volumes={MODELS_DIR: vol},
              secrets=[modal.Secret.from_name("huggingface-worldgen")])
def precache() -> dict:
    """FLUX.1-dev・Fill-dev・作者の LoRA・DA-2・OneFormer を Volume の HF キャッシュへ（CPU）。commit は最後に 1 回。"""
    from huggingface_hub import snapshot_download

    tok = os.environ.get("HF_TOKEN")
    done = {}
    for repo, ignore in HF_REPOS:
        t = time.time()
        p = snapshot_download(repo, token=tok, ignore_patterns=ignore or None, max_workers=8)
        done[repo] = f"{time.time() - t:.0f}s"
        print(f"[precache] {repo} -> {p} ({done[repo]})", flush=True)
    # Real-ESRGAN の重み（超解像）
    if not os.path.exists(ESRGAN_PATH):
        import urllib.request

        os.makedirs(os.path.dirname(ESRGAN_PATH), exist_ok=True)
        urllib.request.urlretrieve(ESRGAN_URL, ESRGAN_PATH + ".part")
        os.replace(ESRGAN_PATH + ".part", ESRGAN_PATH)
    done["esrgan"] = f"{os.path.getsize(ESRGAN_PATH) / 1e6:.0f}MB"
    # LaMa（iopaint）の重みも先に置く（初回の GPU で取りに行かないように）
    try:
        os.environ.setdefault("TORCH_HOME", f"{MODELS_DIR}/worldgen/torch")
        from worldgen.models.inpaint_model import LaMa

        LaMa.download()
        done["lama"] = "ok"
    except Exception as exc:  # noqa: BLE001
        done["lama"] = f"skipped: {exc!r}"
    vol.commit()
    return done


def _patch_seamless(wg) -> None:
    """パノラマの左右の継ぎ目対策: ①混ぜる幅を広げる（gen_pano_image／gen_pano_fill_image の blend_extend）
    ②VAE の復元で、潜在の左右を輪のようにつないでから復元し、つないだ分を切り落とす（端だけ条件が違うことによる段差を消す）。"""
    import functools

    import torch
    import worldgen.worldgen as wgm

    if not getattr(wgm, "_ull_blend_patched", False):
        wgm.gen_pano_image = _gen_pano_rolling  # 文章から: 回しながら描く
        wgm.gen_pano_fill_image = functools.partial(wgm.gen_pano_fill_image, blend_extend=6)  # 画像から: 作者の既定のまま
        wgm._ull_blend_patched = True
    vae = wg.pano_gen_model.vae
    if getattr(vae, "_ull_circular", False):
        return
    orig = vae.decode
    pad = 16  # 潜在の列（＝128px）

    def decode(z, *args, **kwargs):
        zz = torch.cat([z[..., -pad:], z, z[..., :pad]], dim=-1)
        out = orig(zz, *args, **kwargs)
        img = out[0] if isinstance(out, tuple) else out.sample
        k = pad * 8
        img = img[..., k:-k]
        if isinstance(out, tuple):
            return (img,)
        out.sample = img
        return out

    vae.decode = decode
    vae._ull_circular = True


def _gen_pano_rolling(model, prompt="", seed=42, guidance_scale=7.0, num_inference_steps=PANO_STEPS, height=1024, width=2048,
                      prefix="A high quality 360 panorama photo of", suffix="HDR, RAW, 360 consistent, omnidirectional", roll_at=None, **_):
    """WorldGen の gen_pano_image と同じ指示・設定で描く。roll_at step 目までは回さず（部屋の形を決める）、それ以降は毎 step 潜在を
    半周回す（左右の端が毎回入れ替わり、継ぎ目が居座らない）。回した回数が奇数なら最後にもう 1 回回して元の向きにそろえる。"""
    import torch

    h2, w2 = height // 16, width // 16  # 詰めた潜在（2×2 の塊）の縦横

    k = PANO_ROLL_AT if roll_at is None else roll_at

    n_rolls = max(0, num_inference_steps - k)  # i = k..steps-1 で回す

    def roll(pipe, i, t, kw):
        lat = kw["latents"]
        last = i == num_inference_steps - 1
        times = (1 if i >= k else 0) + (1 if last and n_rolls % 2 == 1 else 0)
        if times % 2 == 0:
            return {"latents": lat}
        b, n, c = lat.shape
        return {"latents": lat.view(b, h2, w2, c).roll(w2 // 2, dims=2).reshape(b, n, c)}

    return model(
        f"{prefix}, {prompt}, {suffix}", height=height, width=width, generator=torch.Generator("cpu").manual_seed(seed),
        num_inference_steps=num_inference_steps, blend_extend=0, guidance_scale=guidance_scale,
        callback_on_step_end=roll, callback_on_step_end_tensor_inputs=["latents"],
    ).images[0]


def _upscale_wrap(pano, model):
    """Real-ESRGAN ×4 を、左右を輪のようにつないでかける（継ぎ目を作らない）。縦に分けて GPU の負担を抑える。"""
    import numpy as np
    import torch
    from PIL import Image

    x = torch.from_numpy(np.asarray(pano.convert("RGB"))).permute(2, 0, 1).float().div(255).unsqueeze(0).cuda()
    pad = 64
    x = torch.cat([x[..., -pad:], x, x[..., :pad]], dim=-1)
    outs = []
    tile, ov = 256, 16
    h = x.shape[-2]
    with torch.inference_mode():
        for y0 in range(0, h, tile):
            a, b = max(0, y0 - ov), min(h, y0 + tile + ov)
            y = model(x[..., a:b, :].half()).float()
            outs.append(y[..., (y0 - a) * 4:(y0 - a) * 4 + min(tile, h - y0) * 4, :])
    y = torch.cat(outs, dim=-2)[..., pad * 4:-pad * 4].clamp(0, 1)
    arr = (y[0].permute(1, 2, 0).cpu().numpy() * 255).round().astype(np.uint8)
    return Image.fromarray(arr)


@app.cls(image=image, gpu=GPU, volumes={MODELS_DIR: vol}, timeout=1800, scaledown_window=30, max_containers=2,
         secrets=[modal.Secret.from_name("huggingface-worldgen"), modal.Secret.from_name("supabase-model-downloads"),
                  modal.Secret.from_name("r2-artifacts")])
class WorldGenRunner:
    @modal.enter()
    def start(self):
        os.environ.setdefault("TORCH_HOME", f"{MODELS_DIR}/worldgen/torch")
        # HF_HUB_OFFLINE は付けない: diffusers の load_lora_weights はファイルのパスを渡してもオフラインだと weight_name を求めて止まる
        # （2026-10-10）。重みは precache で Volume の HF キャッシュに置いてあるので、ネットには取りに行かない（キャッシュに当たる）。
        self.wg = None
        self.mode = None

    def _world(self, mode: str):
        """モードごとの WorldGen を使い回す（文章からと画像からで FLUX が違う。両方は 96GB に載らないので切り替え時に捨てる）。"""
        import gc

        import torch
        from worldgen import WorldGen

        if self.wg is not None and self.mode == mode:
            return self.wg, 0.0
        self.wg = None
        gc.collect()
        torch.cuda.empty_cache()
        t0 = time.time()
        wg = WorldGen(mode=mode, device=torch.device("cuda"), low_vram=False, inpaint_bg=True, resolution=PANO_GEN_WIDTH)
        try:
            wg.pano_gen_model.to("cuda")  # bf16 のまま GPU に置く（WorldGen の既定は VRAM 節約の CPU との行き来）
        except Exception as exc:  # noqa: BLE001
            print(f"[worldgen] keep cpu offload: {exc!r}", flush=True)
        _patch_seamless(wg)
        self.wg, self.mode = wg, mode
        return wg, time.time() - t0

    def _esrgan(self):
        if getattr(self, "esrgan", None) is None:
            from spandrel import ModelLoader

            self.esrgan = ModelLoader().load_from_file(ESRGAN_PATH).model.cuda().half().eval()
        return self.esrgan

    def _make(self, mode: str, prompt: str, image_bytes: bytes | None, roll_at: int | None = None) -> dict:
        import torch
        from PIL import Image

        wg, load_s = self._world(mode)
        t1 = time.time()
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB") if image_bytes else None
        import functools

        import worldgen.worldgen as wgm

        if mode == "t2s":
            wgm.gen_pano_image = functools.partial(_gen_pano_rolling, roll_at=roll_at)
        pano = wg.generate_pano(prompt=prompt, image=img)
        pano_s = time.time() - t1
        seam_s = 0.0
        t2 = time.time()
        with torch.inference_mode():
            splat = wg._generate_world(pano)
        splat_s = time.time() - t2
        ply = f"/tmp/scene_{int(time.time() * 1000)}.ply"
        splat.save(ply)
        t3 = time.time()
        big = _upscale_wrap(pano, self._esrgan())
        up_s = time.time() - t3
        buf = io.BytesIO()
        big.save(buf, format="JPEG", quality=92)
        print(f"[worldgen] {mode} load {load_s:.1f}s pano {pano_s:.1f}s seam {seam_s:.1f}s splat {splat_s:.1f}s upscale {up_s:.1f}s -> {big.size}", flush=True)
        return {"pano": buf.getvalue(), "ply_path": ply, "load_s": round(load_s, 1), "pano_s": round(pano_s, 1),
                "splat_s": round(splat_s, 1), "upscale_s": round(up_s, 1), "seam_s": round(seam_s, 1), "width": big.width, "height": big.height}

    @modal.method()
    def generate(self, mode: str, prompt: str = "", image_bytes: bytes | None = None, inpaint_bg: bool = True, resolution: int = 1600,
                 roll_at: int | None = None) -> dict:
        """試作用: パノラマ（PNG）と 3DGS（.ply）を返す（本番は run_job）。"""
        from ull_gpu_monitor import GpuMonitor

        with GpuMonitor(f"worldgen {mode}") as mon:
            res = self._make(mode, prompt, image_bytes, roll_at)
        res["ply"] = pathlib.Path(res.pop("ply_path")).read_bytes()
        res["vram_peak_gb"] = mon.peak_gb
        return res

    @modal.method()
    def run_job(self, job: dict) -> dict:
        """本番: 部屋を作り、パノラマ（PNG）と 3DGS（.ply）を R2 へ上げて generation_jobs を completed に。失敗は failed＋全額返金。
        job: job_id / user_id / credits_cost / mode（t2s|i2s）/ prompt / image_path（i2s のとき studio_uploads の "<userId>/<file>"）。"""
        job_id, user_id = job["job_id"], job["user_id"]
        mode = "i2s" if job.get("mode") == "i2s" else "t2s"
        _patch_job(job_id, {"status": "processing", "started_at": _now_iso(), "progress_message": "部屋を作っています"})
        from ull_gpu_monitor import GpuMonitor

        mon = GpuMonitor(f"worldgen {job_id[:8]}").__enter__()
        try:
            import ull_r2

            if not ull_r2.r2_enabled():
                raise RuntimeError("R2 is not enabled")
            image_bytes = ull_r2.get_upload_bytes("studio_uploads", job["image_path"]) if mode == "i2s" else None
            res = self._make(mode, str(job.get("prompt") or ""), image_bytes)
            rel_png = f"worldgen_results/{user_id}/{job_id}.jpg"
            rel_ply = f"worldgen_results/{user_id}/{job_id}.ply"
            key_png, key_ply = ull_r2.key_for_rel(rel_png, user_id), ull_r2.key_for_rel(rel_ply, user_id)
            ull_r2.put_bytes(res["pano"], key_png, content_type="image/jpeg")
            ull_r2.put_file(res["ply_path"], key_ply, content_type="application/octet-stream")
            meta = {
                "gpu_tier": job.get("gpu_label") or GPU,
                "image_paths": [rel_png],
                "ply_path": rel_ply,
                "r2_keys": [rel_png, rel_ply],
                "r2_key_map": {rel_png: key_png, rel_ply: key_ply},
                "artifact_store": "r2",
                "mode": mode,
                "width": res["width"],
                "height": res["height"],
                "load_s": res["load_s"],
                "pano_s": res["pano_s"],
                "splat_s": res["splat_s"],
                "upscale_s": res["upscale_s"],
            }
            gb = _vram_used_gb()
            if gb is not None:
                meta["vram_used_gb"] = gb
            mon.__exit__(None, None, None)
            meta["vram_peak_gb"] = mon.peak_gb
            _patch_job(job_id, {"status": "completed", "completed_at": _now_iso(), "progress_percent": 100, "metadata": meta})
            return {"ok": True}
        except Exception as exc:
            print(f"[worldgen] job {job_id[:8]} failed: {exc!r}", flush=True)
            mon.__exit__(None, None, None)
            _patch_job(job_id, {"status": "failed", "error_message": str(exc)[:2000], "completed_at": _now_iso(),
                                "metadata": {"gpu_tier": job.get("gpu_label") or GPU, "refunded": True, "vram_peak_gb": mon.peak_gb}})
            _refund(user_id, int(job.get("credits_cost") or 0))
            raise


# --- 本番の受け口（顔入れ替えのワーカーと同じ作り） -------------------------------------------------
def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _sb(method: str, path: str, **kw):
    import requests

    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Supabase env not configured")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", **kw.pop("headers", {})}
    return requests.request(method, f"{url}{path}", headers=headers, timeout=10, **kw)


def _patch_job(job_id: str, fields: dict) -> None:
    """generation_jobs の 1 行を更新（3 回まで再試行・失敗しても止めない）。"""
    for attempt in range(3):
        try:
            r = _sb("PATCH", "/rest/v1/generation_jobs", params={"id": f"eq.{job_id}"},
                    json={**fields, "updated_at": _now_iso()}, headers={"Prefer": "return=minimal"})
            if r.ok:
                return
            print(f"[worldgen] patch {job_id[:8]} HTTP {r.status_code}: {r.text[:200]}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[worldgen] patch {job_id[:8]} failed: {exc!r}", flush=True)
        time.sleep(0.6 * (attempt + 1))


def _refund(user_id: str, amount: int) -> None:
    """失敗したジョブの全額返金。その場で足す（DB の refund_profile_credits）。"""
    if not user_id or amount <= 0:
        return
    try:
        r = _sb("POST", "/rest/v1/rpc/refund_profile_credits", json={"p_user_id": user_id, "p_amount": int(amount)})
        if not r.ok:
            raise RuntimeError(f"HTTP {r.status_code} {r.text[:200]}")
    except Exception as exc:  # noqa: BLE001
        print(f"[worldgen] refund {amount} to {user_id[:8]} failed: {exc!r}", flush=True)


def _vram_used_gb():
    """Active VRAM バッジ用（全系統 vram_used_gb で統一、CLAUDE.md §6-3）。"""
    import subprocess

    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True).stdout.strip().splitlines()
        return round(float(out[0]) / 1024, 1) if out else None
    except Exception:  # noqa: BLE001
        return None


@app.function(image=image, cpu=1, memory=1024, scaledown_window=2, secrets=[modal.Secret.from_name("wan-animate-auth")])
@modal.fastapi_endpoint(method="POST")
def worldgen_async(item: dict, request: fastapi.Request):
    """Next.js から呼ぶ受け口（GPU なし）: 認証して run_job を spawn し、すぐ返す。"""
    import hmac

    expected = os.environ.get("MODAL_AUTH_TOKEN", "")
    provided = request.headers.get("x-modal-secret") or ""
    if not expected or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")
    if not item.get("job_id") or not item.get("user_id") or item.get("mode") not in ("t2s", "i2s"):
        raise fastapi.HTTPException(status_code=400, detail="job_id / user_id / mode are required")
    if item["mode"] == "i2s" and not item.get("image_path"):
        raise fastapi.HTTPException(status_code=400, detail="image_path is required for i2s")
    call = WorldGenRunner().run_job.spawn({**item, "gpu_label": GPU})
    return {"ok": True, "job_id": item["job_id"], "call_id": call.object_id}


@app.local_entrypoint()
def main(mode: str = "t2s", prompt: str = "", image: str = "", out_dir: str = "./worldgen_out", inpaint_bg: bool = True, roll_at: int = -1):
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t = time.time()
    res = WorldGenRunner().generate.remote(mode, prompt, pathlib.Path(image).read_bytes() if image else None, inpaint_bg, 1600,
                                           None if roll_at < 0 else roll_at)
    (out / "pano.jpg").write_bytes(res.pop("pano"))
    (out / "scene.ply").write_bytes(res.pop("ply"))
    print(f"[main] wall {time.time() - t:.0f}s -> {out} {res}")
