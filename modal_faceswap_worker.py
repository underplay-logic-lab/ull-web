"""
Face swap worker on Modal — 画像の頭（顔＋髪型）を参照の顔に入れ替える（2026-10-09 着手・お客さん＝AI 漫画家の要望 1）。

本番: Next.js の /api/studio/face-swap が generation_jobs（workflow_type "face_swap"）を作り、face_swap_async（CPU）へ投げる。
GPU の FaceSwap.run_job が入れ替えを 1 人ずつ順に行い（2 人目は 1 人目の結果に重ねる）、PNG を R2 へ上げて行を completed にする
（失敗は failed＋全額返金）。許可制（user_feature_grants の face_swap_head、src/lib/features.ts）。

採用モデル（CLAUDE.md §5、docs/model-licenses.md・docs/face-swap-eval.md）:
  - Krea 2 Turbo（`Comfy-Org/Krea-2` の krea2_turbo_bf16・TE qwen3vl_4b_bf16・VAE qwen_image_vae、rev 固定）:
    Krea 2 Community License（2026-10-09 確認）。商用無料は年商 100 万ドル未満。**サービス提供者は合理的なコンテンツフィルターを
    実装する義務**・Krea は 30 日前の通知で終了できる → 一般公開せず許可制にして影響を局所化（ホスト判断 2026-10-09）。
  - TE の既定は abliterated 版 `Huihui-Qwen3-VL-4B-Instruct-abliterated`（`huihui-ai/...`・Apache-2.0、2026-10-09 確認）。
    ComfyUI 用の 1 ファイル版（`ahmed22xa/Huihui-Qwen3-VL-4B-Instruct-abliterated-comfy`）をホストが Volume の faceswap/text_encoders/ へ置いた（precache の対象外）。
  - BFS Head Swap v1.1 for Krea 2（`Alissonerdx/BFS-Best-Face-Swap`・MIT、2026-10-09 確認）。作者条件: 有名人・同意のない人には使わない。
  - カスタムノード comfyui-krea2edit（`lbouaraba/comfyui-krea2edit`・Apache-2.0、2026-10-09 確認、コミット固定）。
  - 推論は BF16（CLAUDE.md §1）。手元の評価（5070 Ti）は fp8 だった。

ComfyUI は新規ワーカーなので現時点の最新タグ（v0.39.2）から始める（CLAUDE.md §1。本番に入ったら固定）。
GPU の既定は RTX PRO 6000（本体 26GB＋TE 9GB で 96GB に余裕で収まる。tier の梯子の最下段、CLAUDE.md §1）。env `FACESWAP_GPU` で切り替え。

組み方は手元の `D:\\ComfyUI-ull\\bfs\\swap.py::wf_krea`（公式ワークフローの API 形式）と `multi.py`（左右の指定）と同じ。
TE・プロンプト・step などは SETTINGS にまとめ、ジョブごとに settings で上書きできる（中身はホストが決める）。

  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_faceswap_worker.py::probe       # CPU: import とノードの存在確認
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_faceswap_worker.py::precache    # CPU: 重みを Volume へ
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run modal_faceswap_worker.py::main --cases cases.json --out-dir <dir>   # GPU: 試作
"""

import io
import json
import os
import pathlib
import subprocess
import time

import fastapi
import modal

app = modal.App("ull-face-swap")
MODELS_DIR = "/models"
FS_DIR = f"{MODELS_DIR}/faceswap"
vol = modal.Volume.from_name("ull-wan-models")

COMFY_DIR = "/root/comfy/ComfyUI"
COMFY_PORT = 8188
COMFYUI_REF = os.environ.get("FACESWAP_COMFYUI_REF", "v0.39.2")
KREA2EDIT_REPO = "https://github.com/lbouaraba/comfyui-krea2edit.git"
KREA2EDIT_COMMIT = "86f886dac23013d88996e3a2e99093ba44d322fb"  # v1.2.5（手元の評価と同じ）
GPU = os.environ.get("FACESWAP_GPU", "RTX-PRO-6000")

KREA_REPO = "Comfy-Org/Krea-2"
KREA_REVISION = "eb1eddd3983a54678545a9b2c178c5853b30f7be"
BFS_REPO = "Alissonerdx/BFS-Best-Face-Swap"
BFS_REVISION = "0ca3913ade4b4ada458d60c232354e8586c4c181"
# (HF リポジトリ, リビジョン, リポジトリ内のパス, ComfyUI のモデル種別フォルダ)
WEIGHTS = [
    (KREA_REPO, KREA_REVISION, "diffusion_models/krea2_turbo_bf16.safetensors", "diffusion_models"),
    (KREA_REPO, KREA_REVISION, "text_encoders/qwen3vl_4b_bf16.safetensors", "text_encoders"),
    (KREA_REPO, KREA_REVISION, "vae/qwen_image_vae.safetensors", "vae"),
    (BFS_REPO, BFS_REVISION, "bfs_head_swap_v1.1_krea2.safetensors", "loras"),
]

# 入れ替えの設定（ジョブの settings で上書きできるのはここにあるキーだけ）。
# TE を差し替えるときは WEIGHTS に足して precache し、text_encoder にファイル名を入れる。
SETTINGS = {
    "unet": "krea2_turbo_bf16.safetensors",
    "lora": "bfs_head_swap_v1.1_krea2.safetensors",
    "lora_strength": 1.0,
    # 既定は abliterated 版（ホスト判断 2026-10-09。公式との比較で見た目ほぼ同じ）。公式に戻すなら "qwen3vl_4b_bf16.safetensors"。
    "text_encoder": "Huihui-Qwen3-VL-4B-Instruct-abliterated.safetensors",
    "vae": "qwen_image_vae.safetensors",
    # BFS の Krea 2 用の決まり文句（docs/krea-2.md）。複数人は左右を足す（手元 multi.py で取り違えなし）。
    "prompt": "head_swap: replace the head with the reference head.",
    "prompt_side": "head_swap: replace the head of the person on the {side} with the reference head.",
    "negative": "",
    "system_prompt": "",
    "steps": 10,  # turbo（公式ワークフローの値）
    "cfg": 1.0,
    "sampler": "euler",
    "scheduler": "simple",
    "grounding_px": 512,
    "grounding_px_negative": 768,
    "ref_boost": 1.0,  # 4.0（ノード作者の推奨）は turbo で差が見えなかった（docs/face-swap-eval.md）
    "target_mp": 1.0,  # 生成の解像度（入れ替え先をこの画素数に合わせる。手元の評価は 0.8MP）
    "ref_max_edge": 1024,
    # 入れ替え先が白黒なら参照も白黒にする（カラーの参照だと目だけ色が付く、docs/face-swap-eval.md）。出力も白黒に揃える。
    "gray_threshold": 4.0,
    "gray_output": True,
}
SIDES = ("left", "right")
MAX_SWAPS = 2

image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("git")
    .pip_install(
        "torch",
        "torchvision",
        "torchaudio",
        index_url="https://download.pytorch.org/whl/cu130",
        extra_index_url="https://download.pytorch.org/whl/nightly/cu130",
    )
    .run_commands(
        f"git clone https://github.com/comfyanonymous/ComfyUI.git {COMFY_DIR}",
        f"cd {COMFY_DIR} && git fetch --tags --force && git checkout {COMFYUI_REF}",
        f"cd {COMFY_DIR} && pip install -r requirements.txt",
        f"git clone {KREA2EDIT_REPO} {COMFY_DIR}/custom_nodes/comfyui-krea2edit",
        f"cd {COMFY_DIR}/custom_nodes/comfyui-krea2edit && git checkout {KREA2EDIT_COMMIT}",
    )
    .pip_install("requests", "pillow", "pillow-heif", "huggingface_hub[hf_transfer]", "boto3>=1.35", "fastapi[standard]")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1", "PYTHONUNBUFFERED": "1"})
    # 重みは Volume の /models/faceswap/<種別>/ から読む。
    .run_commands(
        f"printf 'faceswap:\\n  base_path: {FS_DIR}\\n  diffusion_models: diffusion_models\\n"
        f"  text_encoders: text_encoders\\n  vae: vae\\n  loras: loras\\n' > {COMFY_DIR}/extra_model_paths.yaml"
    )
    .add_local_python_source("ull_r2", "ull_gpu_monitor", "ull_image_prep")
)


@app.function(image=image, cpu=2, memory=4096, timeout=600, scaledown_window=2, volumes={MODELS_DIR: vol})
def probe() -> dict:
    """GPU なしで確かめる: torch の import・ComfyUI の版・使うノードがあるか・重みの有無・画像の下ごしらえ。
    ComfyUI 本体は import 時に GPU を要求するので、ノードはソースを見て確かめる。"""
    import torch

    core = pathlib.Path(COMFY_DIR, "nodes.py").read_text(encoding="utf-8")
    custom = pathlib.Path(COMFY_DIR, "custom_nodes", "comfyui-krea2edit", "__init__.py").read_text(encoding="utf-8")
    nodes = {
        "CLIPLoader:krea2": '"krea2"' in core,
        "Krea2EditModelPatch": '"Krea2EditModelPatch"' in custom,
        "Krea2EditGroundedEncode": '"Krea2EditGroundedEncode"' in custom,
    }
    ref = subprocess.run(["git", "-C", COMFY_DIR, "describe", "--tags"], capture_output=True, text=True).stdout.strip()
    weights = {
        pathlib.Path(name).name: os.path.getsize(p) if os.path.exists(p := f"{FS_DIR}/{kind}/{pathlib.Path(name).name}") else None
        for _, _, name, kind in WEIGHTS
    }
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (1200, 1700), (128, 128, 128)).save(buf, format="PNG")
    body = prepare_body(buf.getvalue(), SETTINGS)
    out = {
        "torch": torch.__version__,
        "cuda_build": torch.version.cuda,
        "comfyui": ref,
        "nodes": nodes,
        "weights": weights,
        "prep": {"size": body[0].size, "gray": body[1]},
    }
    print(json.dumps(out, ensure_ascii=False, indent=1), flush=True)
    return out


@app.function(image=image, cpu=4, memory=8192, timeout=3600, scaledown_window=2, volumes={MODELS_DIR: vol})
def precache() -> dict:
    """重み 4 本（約 36GB）を Volume へ。既にあれば飛ばす。commit は最後に 1 回。"""
    import shutil

    from huggingface_hub import hf_hub_download

    done = {}
    for repo, rev, name, kind in WEIGHTS:
        dst = pathlib.Path(FS_DIR, kind, pathlib.Path(name).name)
        if dst.exists() and dst.stat().st_size > 0:
            done[dst.name] = "exists"
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        t = time.time()
        p = hf_hub_download(repo, name, revision=rev, cache_dir="/tmp/hf")
        with open(p, "rb") as fi, open(dst, "wb") as fo:
            shutil.copyfileobj(fi, fo, length=4 * 1024 * 1024)  # Volume は 4MiB 単位で書く（CLAUDE.md §1）
        os.remove(p)  # /tmp を空ける（次の大きいファイルのため）
        done[dst.name] = f"{dst.stat().st_size / 1e9:.2f}GB in {time.time() - t:.0f}s"
        print(f"[precache] {dst} {done[dst.name]}", flush=True)
    vol.commit()
    return done


# --- 画像の下ごしらえ -------------------------------------------------------------------------
def _fit_mp(im, mp: float, multiple: int = 16):
    """縦横比を保って mp メガピクセルに合わせ、辺を multiple の倍数にする（手元 multi.py の fit_mp と同じ）。"""
    from PIL import Image

    w, h = im.size
    s = (mp * 1e6 / (w * h)) ** 0.5
    size = (max(multiple, int(w * s) // multiple * multiple), max(multiple, int(h * s) // multiple * multiple))
    return im if size == im.size else im.resize(size, Image.LANCZOS)


def is_grayscale(im, threshold: float) -> bool:
    """RGB の 3 色の差の平均が threshold 未満なら白黒とみなす（漫画の原稿・白黒の参照）。"""
    from PIL import ImageChops

    small = im.convert("RGB").resize((256, max(1, round(256 * im.height / im.width))))
    r, g, b = small.split()
    diff = ImageChops.add(ImageChops.difference(r, g), ImageChops.difference(g, b), scale=0.5)
    hist = diff.histogram()
    mean = sum(i * n for i, n in enumerate(hist)) / max(1, sum(hist))
    return mean < threshold


def prepare_body(raw: bytes, s: dict):
    """入れ替え先 → (生成解像度の RGB 画像, 白黒か)。"""
    from ull_image_prep import normalize_input_image

    im = normalize_input_image(raw, max_edge=4096, multiple=1)
    gray = is_grayscale(im, float(s["gray_threshold"]))
    return _fit_mp(im, float(s["target_mp"])), gray


def prepare_face(raw: bytes, s: dict, gray: bool):
    """参照の顔 → RGB 画像（入れ替え先が白黒なら白黒に）。"""
    from ull_image_prep import normalize_input_image

    im = normalize_input_image(raw, max_edge=int(s["ref_max_edge"]), multiple=16)
    return im.convert("L").convert("RGB") if gray else im


def build_workflow(s: dict, body_name: str, face_name: str, w: int, h: int, side: str, seed: int) -> dict:
    """手元 swap.py::wf_krea と同じ組み方（BF16 の重みに替えただけ）。side は "" / left / right。"""
    prompt = s["prompt_side"].format(side=side) if side else s["prompt"]
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": s["unet"], "weight_dtype": "default"}},
        "2": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": s["lora"], "strength_model": float(s["lora_strength"])}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": s["text_encoder"], "type": "krea2", "device": "default"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": s["vae"]}},
        "10": {"class_type": "LoadImage", "inputs": {"image": body_name}},
        "11": {"class_type": "LoadImage", "inputs": {"image": face_name}},
        "12": {"class_type": "VAEEncode", "inputs": {"pixels": ["10", 0], "vae": ["6", 0]}},
        "13": {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["6", 0]}},
        "30": {"class_type": "EmptySD3LatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "3": {"class_type": "Krea2EditModelPatch", "inputs": {
            "model": ["2", 0], "source_latent": ["12", 0], "source_latent_b": ["13", 0], "ref_boost": float(s["ref_boost"]),
            "ref_boost_a": 1.0, "fit_mode": "fit", "vae": ["6", 0], "source_image": ["10", 0], "source_image_b": ["11", 0],
            "target_latent": ["30", 0]}},
        "20": {"class_type": "Krea2EditGroundedEncode", "inputs": {
            "clip": ["5", 0], "prompt": prompt, "image": ["10", 0], "image_b": ["11", 0],
            "grounding_px": int(s["grounding_px"]), "system_prompt": s["system_prompt"]}},
        "21": {"class_type": "Krea2EditGroundedEncode", "inputs": {
            "clip": ["5", 0], "prompt": s["negative"], "image": ["10", 0], "image_b": ["11", 0],
            "grounding_px": int(s["grounding_px_negative"]), "system_prompt": s["system_prompt"]}},
        "35": {"class_type": "KSampler", "inputs": {
            "model": ["3", 0], "positive": ["20", 0], "negative": ["21", 0], "latent_image": ["30", 0], "seed": int(seed),
            "steps": int(s["steps"]), "cfg": float(s["cfg"]), "sampler_name": s["sampler"], "scheduler": s["scheduler"], "denoise": 1.0}},
        "36": {"class_type": "VAEDecode", "inputs": {"samples": ["35", 0], "vae": ["6", 0]}},
        "37": {"class_type": "SaveImage", "inputs": {"images": ["36", 0], "filename_prefix": "faceswap/out"}},
    }


def merge_settings(overrides: dict | None) -> dict:
    s = dict(SETTINGS)
    for k, v in (overrides or {}).items():
        if k in SETTINGS:
            s[k] = v
    return s


@app.cls(
    image=image,
    gpu=GPU,
    volumes={MODELS_DIR: vol},
    timeout=1800,
    scaledown_window=30,  # GPU ワーカーの標準（CLAUDE.md §1）。続けて入れ替えるときにコールドスタートを避ける
    max_containers=4,
    # 本番のジョブ（run_job）: generation_jobs の更新・返金（Supabase）と、入出力の置き場所（R2）。
    secrets=[modal.Secret.from_name("supabase-model-downloads"), modal.Secret.from_name("r2-artifacts")],
)
class FaceSwap:
    @modal.enter()
    def start(self):
        import urllib.request

        t = time.time()
        self.proc = subprocess.Popen(
            ["python", "main.py", "--listen", "127.0.0.1", "--port", str(COMFY_PORT)], cwd=COMFY_DIR
        )
        deadline = time.time() + 300
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"ComfyUI exited early (code {self.proc.returncode})")
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{COMFY_PORT}/system_stats", timeout=2)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            raise RuntimeError("ComfyUI did not come up within 300s")
        self.boot_s = round(time.time() - t, 1)
        print(f"[faceswap] ComfyUI up in {self.boot_s}s", flush=True)

    def _run_workflow(self, workflow: dict) -> str:
        """ComfyUI にワークフローを投げ、出来た画像のパスを返す。"""
        import uuid

        import requests

        out_dir = pathlib.Path(COMFY_DIR, "output")
        pre = {str(p) for p in out_dir.rglob("*") if p.is_file()}
        t = time.time()
        r = requests.post(
            f"http://127.0.0.1:{COMFY_PORT}/prompt",
            json={"prompt": workflow, "client_id": str(uuid.uuid4())},
            timeout=30,
        )
        if not r.ok:
            raise RuntimeError(f"ComfyUI rejected the workflow ({r.status_code}): {r.text[:3000]}")
        pid = r.json()["prompt_id"]
        while True:
            h = requests.get(f"http://127.0.0.1:{COMFY_PORT}/history/{pid}", timeout=30).json()
            if pid in h:
                status = h[pid].get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"workflow failed: {json.dumps(status, ensure_ascii=False)[:3000]}")
                break
            # 多めに（CLAUDE.md §0）。手元 5070 Ti の fp8 で 1 枚約 30 秒。
            if time.time() - t > 900:
                raise TimeoutError("face swap workflow timed out")
            time.sleep(0.25)
        new = sorted((p for p in out_dir.rglob("*") if p.is_file() and str(p) not in pre), key=os.path.getmtime)
        if not new:
            raise RuntimeError("workflow finished but produced no image")
        return str(new[-1])

    def _swap(self, body_png: bytes, swaps: list[dict], seed: int, settings: dict | None = None, on_step=None) -> dict:
        """入れ替え先（バイト列）に swaps（[{face: bytes, side: ""|left|right}]）を順に当て、PNG のバイト列を返す。"""
        import uuid

        from PIL import Image

        s = merge_settings(settings)
        body, gray = prepare_body(body_png, s)
        in_dir = pathlib.Path(COMFY_DIR, "input")
        in_dir.mkdir(parents=True, exist_ok=True)
        tag = uuid.uuid4().hex[:8]
        cur = body
        steps = []
        for i, sw in enumerate(swaps):
            if on_step:
                on_step(i)
            face = prepare_face(sw["face"], s, gray)
            body_name, face_name = f"fs_{tag}_{i}_body.png", f"fs_{tag}_{i}_face.png"
            cur.save(in_dir / body_name)
            face.save(in_dir / face_name)
            t = time.time()
            out = self._run_workflow(build_workflow(s, body_name, face_name, cur.width, cur.height, sw.get("side") or "", seed + i))
            elapsed = round(time.time() - t, 2)
            cur = Image.open(out).convert("RGB")
            steps.append({"side": sw.get("side") or "", "elapsed_s": elapsed})
            print(f"[faceswap] #{i + 1} side={sw.get('side') or '-'} {cur.width}x{cur.height} gray={gray} in {elapsed}s (boot {self.boot_s}s)", flush=True)
        if gray and s["gray_output"]:
            cur = cur.convert("L").convert("RGB")
        buf = io.BytesIO()
        cur.save(buf, format="PNG")
        return {"png": buf.getvalue(), "width": cur.width, "height": cur.height, "gray": gray, "steps": steps, "boot_s": self.boot_s}

    @modal.method()
    def generate(self, body: bytes, swaps: list[dict], seed: int = 1, settings: dict | None = None) -> dict:
        """試作用: バイト列を受け取り、結果の PNG バイト列を返す（本番は run_job）。"""
        res = self._swap(body, swaps, seed, settings)
        res["vram_used_gb"] = _vram_used_gb()
        return res

    @modal.method()
    def run_job(self, job: dict) -> dict:
        """本番: R2 の持ち込み（studio_uploads）を読み、入れ替えて PNG を R2 へ上げ、generation_jobs を completed に。
        job: job_id / user_id / credits_cost / seed / body_path / swaps（[{face_path, side}]）/ settings（任意）。
        失敗したら failed にして全額返金。"""
        job_id, user_id = job["job_id"], job["user_id"]
        swaps_in = list(job.get("swaps") or [])[:MAX_SWAPS]
        n = len(swaps_in)
        _patch_job(job_id, {"status": "processing", "started_at": _now_iso(), "progress_message": f"1/{n} 人目" if n > 1 else "入れ替え中"})
        from ull_gpu_monitor import GpuMonitor

        mon = GpuMonitor(f"faceswap {job_id[:8]}").__enter__()
        try:
            import ull_r2

            if not ull_r2.r2_enabled():
                raise RuntimeError("R2 is not enabled")
            if not swaps_in:
                raise ValueError("no swaps")
            body = ull_r2.get_upload_bytes("studio_uploads", job["body_path"])
            swaps = []
            for sw in swaps_in:
                side = sw.get("side") or ""
                if side and side not in SIDES:
                    raise ValueError(f"bad side: {side}")
                swaps.append({"face": ull_r2.get_upload_bytes("studio_uploads", sw["face_path"]), "side": side})

            def on_step(i: int) -> None:
                if i > 0:
                    _patch_job(job_id, {"progress_message": f"{i + 1}/{n} 人目", "progress_percent": int(i * 100 / n),
                                        "metadata": {"vram_used_gb": _vram_used_gb()}})

            res = self._swap(body, swaps, int(job.get("seed", 1)), job.get("settings"), on_step)
            rel = f"faceswap_results/{user_id}/{job_id}.png"
            key = ull_r2.key_for_rel(rel, user_id)
            ull_r2.put_bytes(res["png"], key, content_type="image/png")
            meta = {
                "gpu_tier": job.get("gpu_label") or GPU,
                "image_paths": [rel],
                "r2_keys": [rel],  # ull_r2.stamp_r2_keys と同じく rel パス（実キーは r2_key_map）
                "r2_key_map": {rel: key},
                "artifact_store": "r2",
                "width": res["width"],
                "height": res["height"],
                "gray": res["gray"],
                "steps": res["steps"],
                "boot_s": res["boot_s"],
            }
            gb = _vram_used_gb()
            if gb is not None:
                meta["vram_used_gb"] = gb
            mon.__exit__(None, None, None)
            meta["vram_peak_gb"] = mon.peak_gb
            _patch_job(job_id, {"status": "completed", "completed_at": _now_iso(), "progress_percent": 100, "metadata": meta})
            print(f"[faceswap] job {job_id[:8]} done: {n} swap(s)", flush=True)
            return {"ok": True}
        except Exception as exc:
            print(f"[faceswap] job {job_id[:8]} failed: {exc!r}", flush=True)
            mon.__exit__(None, None, None)
            _patch_job(job_id, {
                "status": "failed",
                "error_message": str(exc)[:2000],
                "completed_at": _now_iso(),
                "metadata": {"gpu_tier": job.get("gpu_label") or GPU, "refunded": True, "vram_peak_gb": mon.peak_gb},
            })
            _refund(user_id, int(job.get("credits_cost") or 0))
            raise


# --- 本番の受け口 -------------------------------------------------------------------------------
def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _sb(method: str, path: str, **kw):
    """Supabase（service role）。失敗は呼び出し側で扱う。"""
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
            print(f"[faceswap] patch {job_id[:8]} HTTP {r.status_code}: {r.text[:200]}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[faceswap] patch {job_id[:8]} failed: {exc!r}", flush=True)
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
        print(f"[faceswap] refund {amount} to {user_id[:8]} failed: {exc!r}", flush=True)


def _vram_used_gb():
    """Active VRAM バッジ用（全系統 vram_used_gb で統一、CLAUDE.md §6-3）。"""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True
        ).stdout.strip().splitlines()
        return round(float(out[0]) / 1024, 1) if out else None
    except Exception:  # noqa: BLE001
        return None


@app.function(image=image, cpu=1, memory=1024, scaledown_window=2, secrets=[modal.Secret.from_name("wan-animate-auth")])
@modal.fastapi_endpoint(method="POST")
def face_swap_async(item: dict, request: fastapi.Request):
    """Next.js から呼ぶ受け口（GPU なし）: 認証して run_job を spawn し、すぐ返す。"""
    import hmac

    expected = os.environ.get("MODAL_AUTH_TOKEN", "")
    provided = request.headers.get("x-modal-secret") or ""
    if not expected or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")
    if not item.get("job_id") or not item.get("user_id") or not item.get("body_path") or not isinstance(item.get("swaps"), list):
        raise fastapi.HTTPException(status_code=400, detail="job_id / user_id / body_path / swaps are required")
    call = FaceSwap().run_job.spawn({**item, "gpu_label": GPU})
    return {"ok": True, "job_id": item["job_id"], "call_id": call.object_id}


@app.local_entrypoint()
def main(cases: str, out_dir: str = "./faceswap_out", seed: int = 47, settings: str = ""):
    """試作: 手元の画像で入れ替える。cases は JSON ファイル（[{"name", "body", "faces": [{"face", "side"}], "settings"?}]）。
    同じコンテナで順に回すので、1 件目が起動込み・2 件目以降が温まった状態の時間になる。settings は JSON（SETTINGS の上書き）。"""
    items = json.loads(pathlib.Path(cases).read_text(encoding="utf-8"))
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    fs = FaceSwap()
    for c in items:
        swaps = [{"face": pathlib.Path(f["face"]).read_bytes(), "side": f.get("side", "")} for f in c["faces"]]
        t = time.time()
        s = {**(json.loads(settings) if settings else {}), **c.get("settings", {})}  # ケースごとの上書き（TE の比べ比べ等）
        res = fs.generate.remote(pathlib.Path(c["body"]).read_bytes(), swaps, seed, s or None)
        dst = out / f"{c['name']}.png"
        dst.write_bytes(res.pop("png"))
        print(f"[main] {c['name']} wall {time.time() - t:.1f}s -> {dst} {json.dumps(res, ensure_ascii=False)}", flush=True)
