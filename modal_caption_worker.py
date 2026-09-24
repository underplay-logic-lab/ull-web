"""LoRA Studio のキャプション解析（自前 VLM）— Qwen3.8-27B-abliterated を transformers でまとめて推論する。

2026-09-24 導入（docs/gpu-benchmarks.md §17）。Gemini はデータセットの一部を安全フィルタで拒否し
（設定では外せない）、有料枠の原価もかかる。同じ 20 枚・本番と同じ指示文で比べて、27B は表情・手・視線を
Gemini 3.8 並みに拾い、拒否もしない。

vLLM も試したが不採用: 生成は 1 枚 0.07〜0.11 秒と速いが、冷えた状態からのエンジン起動が毎回 3〜4 分
（重み 36s＋メモリ計測・CUDA graph 事前記録 105s 等。コンパイルキャッシュを Volume に残しても縮まない）。
LoRA の素材は数百枚どまりなので、起動 14〜33 秒・1 枚 0.5〜0.8 秒（B300・64 枚まとめ）の transformers の方が
依頼から完了までが短い。

構成:
  - caption_dispatch（CPU・軽量）: Next.js から受けて CaptionVLM.run を spawn する。
  - caption_status（CPU・軽量）: 進み具合と途中結果を modal.Dict から返す。
  - CaptionVLM（GPU B300/B200）: R2 の縮小画像を読み、64 枚ずつまとめて生成し、そのたびに途中結果を書く。

モデル / 依存（docs/model-licenses.md）:
  - hotdogs/Qwen3.8-27B-abliterated（Apache-2.0、Volume /models/LLM、bf16・量子化なし）。確認 2026-09-24。
  - transformers 5.5.3 / torch（cu130）。CLAUDE.md §1 の標準（Python 3.13・CUDA 13）どおり。
"""

import os
import time

import fastapi  # どちらのイメージにも入れてある
import modal

app = modal.App("ull-caption-worker")

MODELS_DIR = "/models"
MODEL_PATH = f"{MODELS_DIR}/LLM/Qwen3.8-27B-abliterated"
# まとめて生成する枚数（＝途中結果を書く単位）。時間は枚数ではなく「一番長い出力」で決まるので、
# たいていのデータセットが 1 回で済むよう大きく取る（2026-09-25: 64 → 160。100 枚まとめで VRAM 108GB、B300 は 288GB）。
BATCH = 160
MAX_IMAGES = 500

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)
jobs = modal.Dict.from_name("ull-caption-jobs", create_if_missing=True)

gpu_image = (
    modal.Image.from_registry("nvidia/cuda:13.0.0-devel-ubuntu24.04", add_python="3.13")
    .pip_install(
        "torch", "torchvision",
        index_url="https://download.pytorch.org/whl/cu130",
    )
    .pip_install("transformers==5.5.3", "accelerate", "pillow", "boto3>=1.35", "requests", "fastapi[standard]")
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


def _refund(user_id: str, credits: int) -> None:
    """解析が失敗したら引き落とし分を返す（route と同じく profiles.credits を読んで足す）。"""
    if not user_id or not credits:
        return
    import requests

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print(f"[caption] refund skipped (no supabase env) user={user_id[:8]} {credits}C", flush=True)
        return
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        r = requests.get(f"{url}/rest/v1/profiles", params={"id": f"eq.{user_id}", "select": "credits"}, headers=h, timeout=15)
        cur = int((r.json() or [{}])[0].get("credits") or 0)
        requests.patch(f"{url}/rest/v1/profiles", params={"id": f"eq.{user_id}"}, json={"credits": cur + credits},
                       headers=h, timeout=15).raise_for_status()
        print(f"[caption] refunded {credits}C to {user_id[:8]}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[caption] refund FAILED user={user_id[:8]} {credits}C: {exc!r}", flush=True)


def _readable(raw: str | None) -> bool:
    """出力から英語キャプションが読み取れるか（画面側の parseEnJaArray とほぼ同じ判定）。"""
    import json

    if not raw:
        return False
    for a, b in (("[", "]"), ("{", "}")):
        i, j = raw.find(a), raw.rfind(b)
        if i < 0 or j <= i:
            continue
        try:
            v = json.loads(raw[i:j + 1])
        except Exception:  # noqa: BLE001
            continue
        v = v[0] if isinstance(v, list) and v else v
        if isinstance(v, dict) and str(v.get("en") or "").strip():
            return True
    return False


def _gpu_label() -> str:
    try:
        import torch

        return torch.cuda.get_device_name(0)
    except Exception:  # noqa: BLE001
        return "?"


@app.cls(
    image=gpu_image,
    gpu=["B300", "B200"],
    volumes={MODELS_DIR: vol},
    timeout=30 * 60,
    # 終わったら 2 秒で止める（2026-09-25 ホスト判断「連続でやることはない」）。B300 の待機課金を残さない。
    scaledown_window=2,
    min_containers=0,
    retries=0,
    secrets=[modal.Secret.from_name("r2-artifacts"), modal.Secret.from_name("supabase-model-downloads")],
)
class CaptionVLM:
    @modal.enter()
    def load(self):
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        t0 = time.time()
        self.proc = AutoProcessor.from_pretrained(MODEL_PATH, local_files_only=True)
        self.proc.tokenizer.padding_side = "left"
        # GPU へ直接読む。CPU RAM 経由（.to("cuda")）だと 27B で 20 分超かかった（2026-09-24）。
        self.model = AutoModelForImageTextToText.from_pretrained(
            MODEL_PATH, local_files_only=True, torch_dtype=torch.bfloat16, device_map="cuda", attn_implementation="sdpa"
        ).eval()
        self.load_s = round(time.time() - t0, 1)
        print(f"[caption] model ready in {self.load_s}s on {_gpu_label()}", flush=True)

    @modal.method()
    def run(self, job: dict) -> dict:
        import io
        from concurrent.futures import ThreadPoolExecutor

        import torch
        import ull_r2
        from PIL import Image

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
                    return Image.open(io.BytesIO(ull_r2.get_bytes(k))).convert("RGB")
                except Exception as exc:  # noqa: BLE001 — その 1 枚だけ空で返す
                    print(f"[caption] fetch failed {k}: {exc!r}", flush=True)
                    return None

            with ThreadPoolExecutor(max_workers=16) as ex:
                images = list(ex.map(_fetch, keys))
            fetch_s = round(time.time() - t0, 1)

            msgs = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": job["prompt"]}]}]
            text = self.proc.apply_chat_template(msgs, add_generation_prompt=True, tokenize=False,
                                                 enable_thinking=False)
            max_new = int(job.get("max_tokens") or 600)
            t1 = time.time()
            for s in range(0, total, BATCH):
                idx = [i for i in range(s, min(total, s + BATCH)) if images[i] is not None]
                if idx:
                    inp = self.proc(text=[text] * len(idx), images=[images[i] for i in idx],
                                    return_tensors="pt", padding=True).to("cuda")
                    with torch.inference_mode():
                        ids = self.model.generate(**inp, max_new_tokens=max_new, do_sample=False)
                    outs = self.proc.batch_decode(ids[:, inp["input_ids"].shape[1]:], skip_special_tokens=True)
                    for i, o in zip(idx, outs):
                        state["raws"][i] = o
                state["done"] = min(total, s + BATCH)
                jobs[key] = state
            # 読み取れない出力（英語キャプションが取れない・途中で切れた等）は、GPU が温かいうちに
            # その画像だけもう 1 回（2026-09-25 ホスト指摘「取りこぼしの再解析は温かいうちに」）。
            retry = [i for i in range(total) if images[i] is not None and not _readable(state["raws"][i])]
            if retry:
                print(f"[caption] {key} retrying {len(retry)} unreadable output(s)", flush=True)
                inp = self.proc(text=[text] * len(retry), images=[images[i] for i in retry],
                                return_tensors="pt", padding=True).to("cuda")
                with torch.inference_mode():
                    ids = self.model.generate(**inp, max_new_tokens=max_new + 300, do_sample=False)
                outs = self.proc.batch_decode(ids[:, inp["input_ids"].shape[1]:], skip_special_tokens=True)
                for i, o in zip(retry, outs):
                    if _readable(o):
                        state["raws"][i] = o
                state["retried"] = len(retry)
            gen_s = round(time.time() - t1, 1)
            state.update({"status": "completed", "done": total, "fetch_s": fetch_s, "gen_s": gen_s,
                          "gpu": _gpu_label()})
            jobs[key] = state
            print(f"[caption] {key} {total} imgs: fetch {fetch_s}s, generate {gen_s}s "
                  f"({gen_s / max(1, total):.2f}s/img), model load {self.load_s}s", flush=True)
        except Exception as exc:  # noqa: BLE001
            state.update({"status": "failed", "error": f"{type(exc).__name__}: {exc}"[:500]})
            jobs[key] = state
            print(f"[caption] {key} FAILED: {exc!r}", flush=True)
            _refund(str(job.get("user_id") or ""), int(job.get("credits_cost") or 0))
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
    call = CaptionVLM().run.spawn({"dict_key": key, "keys": [str(k) for k in keys], "prompt": prompt,
                                   "max_tokens": body.get("max_tokens"), "user_id": body.get("user_id"),
                                   "credits_cost": body.get("credits_cost")})
    # 打ち切り（caption_abort）で取り消し・返金できるよう、呼び出しと料金を残す。
    jobs[key] = {"status": "queued", "done": 0, "total": len(keys), "raws": [None] * len(keys),
                 "call_id": call.object_id, "user_id": body.get("user_id"),
                 "credits_cost": int(body.get("credits_cost") or 0), "queued_at": time.time()}
    return {"ok": True, "call_id": call.object_id}


@app.function(
    image=endpoint_image,
    secrets=[modal.Secret.from_name("wan-animate-auth"), modal.Secret.from_name("supabase-model-downloads")],
    timeout=60,
    scaledown_window=60,
)
@modal.fastapi_endpoint(method="POST")
def caption_abort(body: dict, request: fastapi.Request):
    """解析が始まらないまま時間が経った（GPU の起動・読み込みの失敗）ときの打ち切り（2026-09-25）。
    まだ queued のときだけ、呼び出しを取り消して failed にし、引き落とし分を返す。走り出していたら何もしない。"""
    _authorize(request)
    key = str(body.get("dict_key") or "")
    st = jobs.get(key) if key else None
    if not st or st.get("status") != "queued":
        return {"ok": True, "aborted": False, "status": (st or {}).get("status", "unknown")}
    try:
        modal.FunctionCall.from_id(str(st.get("call_id"))).cancel()
    except Exception as exc:  # noqa: BLE001
        print(f"[caption] cancel failed {key}: {exc!r}", flush=True)
    st.update({"status": "failed", "error": "起動がタイムアウトしました"})
    jobs[key] = st
    _refund(str(st.get("user_id") or ""), int(st.get("credits_cost") or 0))
    return {"ok": True, "aborted": True}


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
