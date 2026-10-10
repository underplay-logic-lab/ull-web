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

import os
import pathlib
import time

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
        "huggingface_hub[hf_transfer]", "requests", "loguru",
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
    .add_local_python_source("ull_gpu_monitor")
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


@app.cls(image=image, gpu=GPU, volumes={MODELS_DIR: vol}, timeout=1800, scaledown_window=30, max_containers=2,
         secrets=[modal.Secret.from_name("huggingface-worldgen")])
class WorldGenRunner:
    @modal.method()
    def generate(self, mode: str, prompt: str = "", image_bytes: bytes | None = None, inpaint_bg: bool = True, resolution: int = 1600) -> dict:
        """パノラマ（PNG）と 3DGS（.ply）を作って返す。"""
        import io

        import torch
        from PIL import Image

        os.environ.setdefault("TORCH_HOME", f"{MODELS_DIR}/worldgen/torch")
        # HF_HUB_OFFLINE は付けない: diffusers の load_lora_weights はファイルのパスを渡してもオフラインだと weight_name を求めて止まる
        # （2026-10-10）。重みは precache で Volume の HF キャッシュに置いてあるので、ネットには取りに行かない（キャッシュに当たる）。
        from ull_gpu_monitor import GpuMonitor
        from worldgen import WorldGen

        with GpuMonitor(f"worldgen {mode}") as mon:
            t0 = time.time()
            wg = WorldGen(mode=mode, device=torch.device("cuda"), low_vram=False, inpaint_bg=inpaint_bg, resolution=resolution)
            # bf16 のまま GPU に置く（96GB に載る。WorldGen の既定は VRAM 節約のための CPU との行き来）
            try:
                wg.pano_gen_model.to("cuda")
            except Exception as exc:  # noqa: BLE001
                print(f"[worldgen] keep cpu offload: {exc!r}", flush=True)
            load_s = time.time() - t0
            t1 = time.time()
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB") if image_bytes else None
            pano = wg.generate_pano(prompt=prompt, image=img)
            pano_s = time.time() - t1
            t2 = time.time()
            with torch.inference_mode():
                splat = wg._generate_world(pano)
            splat_s = time.time() - t2
            ply = "/tmp/scene.ply"
            splat.save(ply)
            buf = io.BytesIO()
            pano.save(buf, format="PNG")
        res = {
            "pano": buf.getvalue(),
            "ply": pathlib.Path(ply).read_bytes(),
            "load_s": round(load_s, 1),
            "pano_s": round(pano_s, 1),
            "splat_s": round(splat_s, 1),
            "vram_peak_gb": mon.peak_gb,
        }
        print(f"[worldgen] {mode} load {res['load_s']}s pano {res['pano_s']}s splat {res['splat_s']}s peak {mon.peak_gb}GB", flush=True)
        return res



@app.local_entrypoint()
def main(mode: str = "t2s", prompt: str = "", image: str = "", out_dir: str = "./worldgen_out", inpaint_bg: bool = True):
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    t = time.time()
    res = WorldGenRunner().generate.remote(mode, prompt, pathlib.Path(image).read_bytes() if image else None, inpaint_bg)
    (out / "pano.png").write_bytes(res.pop("pano"))
    (out / "scene.ply").write_bytes(res.pop("ply"))
    print(f"[main] wall {time.time() - t:.0f}s -> {out} {res}")
