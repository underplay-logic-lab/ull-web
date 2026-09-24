"""LoRA Studio のキャプション解析（自前 VLM）— Qwen3.8-27B-abliterated を vLLM で一括推論する。

2026-09-24 導入（docs/gpu-benchmarks.md §17）。Gemini はデータセットの一部を安全フィルタで拒否し
（設定では外せない）、有料枠の原価もかかる。同じ 20 枚・本番と同じ指示文で比べて、27B は表情・手・視線を
Gemini 3.8 並みに拾い、拒否もしない。vLLM（B300）は 1 枚 0.07〜0.11 秒で、コンパイル結果を Volume に
残すと起動 50〜85 秒（初回・版の入れ替え直後だけ約 5 分）。

構成（CLAUDE.md §1 の例外: ComfyUI を使わない推論専用なので、vLLM 0.30.0 の推奨構成をそのまま使う。
torch 2.13.0+cu130 で結果的に CUDA 13 標準にも合っている。flashinfer 等が起動時に JIT で nvcc を呼ぶので
CUDA devel イメージが要る）:
  - caption_dispatch（CPU・軽量）: Next.js から受けて CaptionVLM.run を spawn する。
  - caption_status（CPU・軽量）: 進み具合と途中結果を modal.Dict から返す。
  - CaptionVLM（GPU B300/B200）: R2 の縮小画像を読み、1 枚 1 会話で一括生成し、64 枚ごとに途中結果を書く。

モデル / 依存:
  - huihui-ai 系 Qwen3.8-27B-abliterated（Volume /models/LLM、Qwen3.5 系アーキテクチャ・bf16）。
    ライセンスは元の Qwen に準拠（docs/model-licenses.md）。量子化なし。
  - vLLM 0.30.0（Apache-2.0）、確認 2026-09-24。
"""

import os
import time

import fastapi  # vLLM の依存に含まれ、エンドポイント用イメージにも入れてある
import modal

app = modal.App("ull-caption-worker")

MODELS_DIR = "/models"
MODEL_PATH = f"{MODELS_DIR}/LLM/Qwen3.8-27B-abliterated"
VLLM_CACHE_ROOT = f"{MODELS_DIR}/_vllm_cache"
CHUNK = 64  # 途中結果を書く単位。vLLM はこの中で全部を同時に回す
MAX_IMAGES = 500

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)
jobs = modal.Dict.from_name("ull-caption-jobs", create_if_missing=True)

vllm_image = (
    modal.Image.from_registry("nvidia/cuda:13.0.0-devel-ubuntu24.04", add_python="3.13")
    .pip_install("vllm==0.30.0", "pillow", "boto3>=1.35", "requests")
    .add_local_python_source("ull_r2")
)
endpoint_image = modal.Image.debian_slim(python_version="3.13").pip_install("fastapi[standard]")


def _authorize(request: fastapi.Request) -> None:
    import hmac

    expected = os.environ.get("MODAL_AUTH_TOKEN")
    if not expected:
        raise fastapi.HTTPException(status_code=500, detail="Server auth is not configured.")
    provided = request.headers.get("x-modal-secret") or request.headers.get("authorization", "").removeprefix(
        "Bearer "
    ).strip()
    if not provided or not hmac.compare_digest(provided, expected):
        raise fastapi.HTTPException(status_code=401, detail="Unauthorized")


def _gpu_label() -> str:
    try:
        import torch

        return torch.cuda.get_device_name(0)
    except Exception:  # noqa: BLE001
        return "?"


@app.cls(
    image=vllm_image,
    gpu=["B300", "B200"],
    volumes={MODELS_DIR: vol},
    timeout=30 * 60,
    scaledown_window=30,
    min_containers=0,
    retries=0,
    secrets=[modal.Secret.from_name("r2-artifacts")],
)
class CaptionVLM:
    @modal.enter()
    def load(self):
        # コンパイル結果を Volume に残し、次のコールドスタートで使い回す（起動 342s → 50〜85s）。
        os.environ["VLLM_CACHE_ROOT"] = VLLM_CACHE_ROOT
        from vllm import LLM

        t0 = time.time()
        self.llm = LLM(
            model=MODEL_PATH,
            dtype="bfloat16",
            max_model_len=8192,
            gpu_memory_utilization=0.90,
            limit_mm_per_prompt={"image": 1},
            max_num_seqs=256,
            # Volume（ネットワーク越し）から 1 ファイルずつ読むと 25 秒/ファイルかかった。並行で読む。
            model_loader_extra_config={"enable_multithread_load": True, "num_threads": 16},
        )
        self.load_s = round(time.time() - t0, 1)
        print(f"[caption] engine ready in {self.load_s}s on {_gpu_label()}", flush=True)
        try:
            vol.commit()  # 新しいコンパイル結果を残す
        except Exception as exc:  # noqa: BLE001
            print(f"[caption] vol.commit skipped: {exc}", flush=True)

    @modal.method()
    def run(self, job: dict) -> dict:
        import base64
        from concurrent.futures import ThreadPoolExecutor

        import ull_r2
        from vllm import SamplingParams

        key = job["dict_key"]
        keys: list[str] = job["keys"]
        total = len(keys)
        state = {"status": "running", "done": 0, "total": total, "raws": [None] * total,
                 "load_s": self.load_s, "started_at": time.time()}
        jobs[key] = state
        t0 = time.time()
        try:
            def _fetch(k: str):
                try:
                    return ull_r2.get_bytes(k)
                except Exception as exc:  # noqa: BLE001 — その 1 枚だけ空で返す
                    print(f"[caption] fetch failed {k}: {exc!r}", flush=True)
                    return None

            with ThreadPoolExecutor(max_workers=16) as ex:
                blobs = list(ex.map(_fetch, keys))
            fetch_s = round(time.time() - t0, 1)

            sp = SamplingParams(temperature=0.0, max_tokens=int(job.get("max_tokens") or 600))
            prompt = job["prompt"]
            t1 = time.time()
            for s in range(0, total, CHUNK):
                idx = [i for i in range(s, min(total, s + CHUNK)) if blobs[i]]
                convs = []
                for i in idx:
                    mime = "image/webp" if keys[i].endswith(".webp") else "image/jpeg"
                    url = f"data:{mime};base64," + base64.b64encode(blobs[i]).decode("ascii")
                    convs.append([{"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": url}},
                        {"type": "text", "text": prompt},
                    ]}])
                if convs:
                    outs = self.llm.chat(convs, sp, chat_template_kwargs={"enable_thinking": False}, use_tqdm=False)
                    for i, o in zip(idx, outs):
                        state["raws"][i] = o.outputs[0].text
                state["done"] = min(total, s + CHUNK)
                jobs[key] = state
            gen_s = round(time.time() - t1, 1)
            state.update({"status": "completed", "done": total, "fetch_s": fetch_s, "gen_s": gen_s,
                          "gpu": _gpu_label()})
            jobs[key] = state
            print(f"[caption] {key} {total} imgs: fetch {fetch_s}s, generate {gen_s}s "
                  f"({gen_s / max(1, total):.2f}s/img), engine {self.load_s}s", flush=True)
        except Exception as exc:  # noqa: BLE001
            state.update({"status": "failed", "error": f"{type(exc).__name__}: {exc}"[:500]})
            jobs[key] = state
            print(f"[caption] {key} FAILED: {exc!r}", flush=True)
        finally:
            try:
                ull_r2.delete_keys(keys)  # 縮小画像は解析が済めば要らない
            except Exception as exc:  # noqa: BLE001
                print(f"[caption] input cleanup skipped: {exc!r}", flush=True)
        return {"status": state["status"], "total": total}


@app.function(
    image=endpoint_image,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
    timeout=60,
    scaledown_window=60,
)
@modal.fastapi_endpoint(method="POST")
def caption_dispatch(body: dict, request: fastapi.Request):
    _authorize(request)
    key = str(body.get("dict_key") or "")
    keys = body.get("keys") or []
    prompt = str(body.get("prompt") or "")
    if not key or not isinstance(keys, list) or not keys or len(keys) > MAX_IMAGES or not prompt:
        raise fastapi.HTTPException(status_code=400, detail="invalid job")
    jobs[key] = {"status": "queued", "done": 0, "total": len(keys), "raws": [None] * len(keys)}
    call = CaptionVLM().run.spawn({"dict_key": key, "keys": [str(k) for k in keys], "prompt": prompt,
                                   "max_tokens": body.get("max_tokens")})
    return {"ok": True, "call_id": call.object_id}


@app.function(
    image=endpoint_image,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
    timeout=30,
    scaledown_window=60,
)
@modal.fastapi_endpoint(method="GET")
def caption_status(dict_key: str, request: fastapi.Request):
    _authorize(request)
    st = jobs.get(dict_key)
    if not st:
        return {"status": "unknown"}
    return st
