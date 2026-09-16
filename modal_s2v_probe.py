"""
Wan2.2-S2V-14B（Speech-to-Video）実機検証スクリプト。

目的: Cinematic Director（MiniMax H3 ネイティブのリップシンク）との品質/速度
比較のためのベンチマーク。**本番ワーカーではない** — 検証専用の使い捨てスク
リプト。採用が決まった場合は modal_lora_worker.py 等と同じ標準パターン
（scaledown_window/torch.compile/非同期ジョブテーブル等、CLAUDE.md §1・§6）
で作り直す。

ライセンス確認済み（2026-09-16）: Wan-AI/Wan2.2-S2V-14B は Apache-2.0、地域
制限なしの記載、商用利用可（HuggingFace モデルカード）。CLAUDE.md §5 の
「可（確認済み・商用OK）」基準を満たす。

VRAM: 公式 README で単一GPU推論に「at least 80GB VRAM」と明記。B300は
これを大きく上回るため、CLAUDE.md §1 の量子化/オフロード禁止方針に従い
--offload_model は使わずフル BF16 常駐で実行する。

実行:
  modal run modal_s2v_probe.py::cpu_probe
      CPU専用。依存関係のインポート確認 + モデル重み(~49GB)を
      ull-wan-models Volume の checkpoints/Wan2.2-S2V-14B/ へダウンロード。

  modal run modal_s2v_probe.py::gpu_generate --image-path <local.jpg> --audio-path <local.wav>
      B300。実際に動画を生成し、ローカルに結果 mp4 を書き出す。
"""

import pathlib

import modal

app = modal.App("ull-s2v-probe")

MODELS_DIR = "/models"
S2V_CKPT_DIR = f"{MODELS_DIR}/checkpoints/Wan2.2-S2V-14B"
REPO_DIR = "/root/Wan2.2"
HF_HUB_CACHE_DIR = f"{MODELS_DIR}/training/hf_cache/hub"

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)

# CLAUDE.md §1: 標準GPUはBlackwell。
GPU_REQUEST = ["b300", "b200"]

# CLAUDE.md §1 のBlackwell標準セットアップ（modal_lora_worker.py /
# modal_wan_animate_blackwell.py と同一パターン）: nvidia/cuda:13.0.0-devel
# + Python 3.13 + cu130 torch。
base_image = (
    modal.Image.from_registry(
        "nvidia/cuda:13.0.0-devel-ubuntu24.04",
        add_python="3.13",
    )
    .apt_install(
        "git", "ffmpeg", "libgl1", "libglib2.0-0", "wget",
        "build-essential", "ninja-build",
    )
    .env(
        {
            "CUDA_HOME": "/usr/local/cuda",
            "PATH": "/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LD_LIBRARY_PATH": "/usr/local/cuda/lib64",
            "TORCH_CUDA_ARCH_LIST": "10.0;10.3;12.0;10.0+PTX",
            "CC": "gcc",
            "CXX": "g++",
            "HF_HOME": f"{MODELS_DIR}/training/hf_cache",
            "HF_HUB_CACHE": HF_HUB_CACHE_DIR,
        }
    )
    .pip_install(
        "torch", "torchvision", "torchaudio",
        extra_index_url="https://download.pytorch.org/whl/cu130",
    )
    .pip_install("huggingface_hub[cli]", "hf_transfer")
    # requirements.txt が宣言し忘れている推移依存（2026-09-16 実機確認）。
    .pip_install("einops", "librosa", "soundfile", "decord", "peft")
    .run_commands(f"git clone https://github.com/Wan-Video/Wan2.2.git {REPO_DIR}")
    .run_commands(
        # requirements.txt の flash_attn はソースビルドが pip のビルド分離下で
        # torch を見つけられず失敗し（setup.py が素の import torch を要求する
        # 古い packaging）、requirements.txt 全体のインストールを道連れに
        # 落としていた（transformers 等が丸ごと入らない事故、2026-09-16実機
        # 確認）。Wan2.2 の attention モジュールは flash_attn を
        # try/except でオプトインしており無くても SDPA へフォールバックする
        # ので、この検証では flash_attn 行だけ除いてインストールする。
        f"cd {REPO_DIR} && sed -i '/^flash_attn/d' requirements.txt",
        f"cd {REPO_DIR} && pip install -r requirements.txt",
        # ai-toolkit と同じ防御パターン: 上のインストールが torch を
        # 非cu130版に引っ張った場合に備え、cu130 torch を force-reinstall
        # で上書きする。
        "pip install --no-deps --force-reinstall torch torchvision torchaudio "
        "--extra-index-url https://download.pytorch.org/whl/cu130",
        "python -c 'import torch; print(\"[image] torch:\", torch.__version__, torch.version.cuda)'",
        # numpy 1.26.4 が入る（requirements.txtのnumpy<2ピンとcp313対応の
        # 兼ね合い）→ transformers 4.51.3 系の古いコードが参照する np.long
        # 等の削除済みエイリアスで RuntimeError（2026-09-16実機確認）。
        # sitecustomize.py は Modal のコンテナ実行時には読み込まれない
        # （ビルド時の `RUN python -c` では効くが実行時は無効、実機確認済み）
        # ため、numpy パッケージの __init__.py 本体に直接追記して確実に効かせる。
        "python -c \"import numpy, pathlib; p = pathlib.Path(numpy.__file__); "
        "p.write_text(p.read_text() + '\\n# ULL shim: restore removed/version-straddling numpy aliases\\n'"
        " + '\\n'.join(f'{n} = {n}' for n in ('int', 'float', 'bool', 'object', 'str', 'complex'))"
        " + '\\nlong = int\\nulong = int\\n')\"",
        "python -c 'import numpy; print(\"[image] numpy:\", numpy.__version__, \"shim ok:\", numpy.long is int, numpy.ulong is int)'",
    )
    .run_commands(
        # wan/modules/s2v/model_s2v.py の attention は flash_attn を
        # `assert FLASH_ATTN_2_AVAILABLE` でハード要求しており SDPA への
        # フォールバックが無い（B300実機で172秒モデルロード後にクラッシュ、
        # 2026-09-16確認）。`pip install flash-attn` は CLAUDE.md §1 の
        # SageAttention と全く同じ「setup.py が -std=c++17 をハードコード
        # しているが cu130/torch 2.14 のヘッダーは C++20 を要求する」で
        # ビルド失敗する（実機確認: `#error C++20 or later compatible
        # compiler is required to use ATen.`）。SageAttensionと違い
        # flash-attnのsetup.pyには CXX_APPEND_FLAGS のような環境変数の
        # 注入口が無いため、git clone してsetup.py本体を直接sedで
        # 書き換える。
        "git clone --depth 1 https://github.com/Dao-AILab/flash-attention.git /root/flash-attention",
        "sed -i 's/-std=c++17/-std=c++20/g' /root/flash-attention/setup.py",
        "cd /root/flash-attention && MAX_JOBS=4 pip install --no-build-isolation . "
        "|| echo '[image] flash-attn build FAILED — S2V will crash without SDPA fallback'",
    )
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
)


@app.function(
    image=base_image,
    volumes={MODELS_DIR: vol},
    timeout=3600,
    secrets=[modal.Secret.from_name("huggingface-secret")],
)
def cpu_probe() -> dict:
    """CPU専用: import連鎖の確認 + モデル重みダウンロード。GPU起動なし。"""
    import sys

    report: dict = {"imports_ok": False, "errors": []}

    sys.path.insert(0, REPO_DIR)
    try:
        import torch  # noqa: F401
        import torchaudio  # noqa: F401
        import transformers  # noqa: F401
        import wan  # type: ignore  # noqa: F401  (Wan2.2 repo package)

        report["imports_ok"] = True
        print("[cpu_probe] import chain OK (torch/torchaudio/transformers/wan)", flush=True)
    except Exception as exc:  # noqa: BLE001
        report["errors"].append(f"import failed: {exc}")
        print(f"[cpu_probe] IMPORT FAILED: {exc}", flush=True)

    from huggingface_hub import snapshot_download

    dest = pathlib.Path(S2V_CKPT_DIR)
    dest.mkdir(parents=True, exist_ok=True)
    print(f"[cpu_probe] downloading Wan-AI/Wan2.2-S2V-14B -> {dest} (~49GB)", flush=True)
    try:
        snapshot_download(
            repo_id="Wan-AI/Wan2.2-S2V-14B",
            local_dir=str(dest),
        )
        report["download_ok"] = True
    except Exception as exc:  # noqa: BLE001
        report["download_ok"] = False
        report["errors"].append(f"download failed: {exc}")
        print(f"[cpu_probe] DOWNLOAD FAILED: {exc}", flush=True)

    vol.commit()

    files = sorted(p.name for p in dest.rglob("*") if p.is_file())
    total_bytes = sum(p.stat().st_size for p in dest.rglob("*") if p.is_file())
    report["file_count"] = len(files)
    report["total_gb"] = round(total_bytes / 1024**3, 2)
    print(f"[cpu_probe] {len(files)} files, {report['total_gb']} GB on volume", flush=True)

    return report


@app.function(image=base_image, gpu="t4", volumes={MODELS_DIR: vol}, timeout=300)
def cheap_gpu_import_probe() -> str:
    """CLAUDE.md §1: 「GPUの存在自体は必要だが計算力は不要」なケースは最安
    tierを使う。`wan` パッケージは import 時に torch.cuda を無条件に叩く
    ため CPU コンテナでは import できない — B300 で課金する前に、ここで
    import 連鎖だけ安く確認する。"""
    import sys

    sys.path.insert(0, REPO_DIR)
    import wan  # noqa: F401
    from wan.configs import WAN_CONFIGS  # noqa: F401

    return f"wan import OK. tasks={sorted(WAN_CONFIGS.keys())}"


@app.function(
    image=base_image,
    gpu=GPU_REQUEST,
    volumes={MODELS_DIR: vol},
    timeout=3600,
)
def gpu_generate(image_bytes: bytes, audio_bytes: bytes, prompt: str) -> bytes:
    """B300実機: s2v-14B で実際に動画を生成し、mp4のバイト列を返す。

    CLAUDE.md §1: 量子化/オフロード禁止方針のため --offload_model False を
    明示してフルBF16常駐で実行する（B300のVRAMは公式最低要件80GBを大きく
    上回る）。
    """
    import subprocess
    import tempfile
    import time

    work = pathlib.Path(tempfile.mkdtemp())
    image_path = work / "ref_image.jpg"
    audio_path = work / "ref_audio.wav"
    out_path = work / "s2v_out.mp4"
    image_path.write_bytes(image_bytes)
    audio_path.write_bytes(audio_bytes)

    cmd = [
        "python", "generate.py",
        "--task", "s2v-14B",
        "--size", "1024*704",
        "--ckpt_dir", S2V_CKPT_DIR,
        "--convert_model_dtype",
        # 2026-09-16 実機確認: 未指定だと単一GPU実行時は自動的に
        # offload_model=True になる（generate.py の str2bool 引数、
        # `if args.offload_model is None: ... = True if world_size==1`）。
        # CLAUDE.md §1 のオフロード禁止方針のため明示的に無効化する。
        "--offload_model", "False",
        "--prompt", prompt,
        "--image", str(image_path),
        "--audio", str(audio_path),
        "--save_file", str(out_path),
    ]
    print(f"[gpu_generate] running: {' '.join(cmd)}", flush=True)

    # CLAUDE.md §1: capture_output=True で溜め込んで最後に一括printすると、
    # ジョブ完了まで設定ミス（offload/精度等）に気づけない。Popen で
    # 標準出力を1行ずつ即時flushし、起動直後のNamespaceログ等を数十秒以内に
    # 確認できるようにする。
    started = time.time()
    lines: list[str] = []
    proc = subprocess.Popen(
        cmd, cwd=REPO_DIR, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line, end="", flush=True)
        lines.append(line)
    returncode = proc.wait()
    elapsed = time.time() - started
    print(f"[gpu_generate] elapsed {elapsed:.1f}s, returncode={returncode}", flush=True)
    if returncode != 0:
        raise RuntimeError(f"generate.py failed (code {returncode}) after {elapsed:.1f}s")

    if not out_path.exists():
        raise RuntimeError(f"generate.py exited 0 but no output at {out_path}")

    # 後で見返せるよう Volume にも残す。
    persist = pathlib.Path(MODELS_DIR) / "outputs" / "s2v_probe" / f"s2v_{int(started)}.mp4"
    persist.parent.mkdir(parents=True, exist_ok=True)
    persist.write_bytes(out_path.read_bytes())
    vol.commit()
    print(f"[gpu_generate] also saved to volume: {persist}", flush=True)

    return out_path.read_bytes()


@app.local_entrypoint()
def main(image_path: str = "", audio_path: str = "", prompt: str = "", out: str = "s2v_result.mp4"):
    if not image_path or not audio_path:
        print("usage: modal run modal_s2v_probe.py::main --image-path X --audio-path Y [--prompt ...]")
        return
    # 2026-09-16: 前回テストで "static shot" と明記していたせいで表情・
    # ポーズがほぼ静止したまま出力され、MiniMax H3参照動画（大きな身振り・
    # 表情変化あり）とフェアな比較にならなかった。動きを抑制しない表現に修正。
    default_prompt = (
        "An anime girl speaks and sings expressively to the camera, with lively "
        "facial expressions, natural head and hand gestures, and lip movements "
        "matching the audio, cinematic lighting, dynamic camera."
    )
    img_bytes = pathlib.Path(image_path).read_bytes()
    aud_bytes = pathlib.Path(audio_path).read_bytes()
    video_bytes = gpu_generate.remote(img_bytes, aud_bytes, prompt or default_prompt)
    pathlib.Path(out).write_bytes(video_bytes)
    print(f"[main] wrote {out} ({len(video_bytes) / 1024**2:.2f} MB)")
