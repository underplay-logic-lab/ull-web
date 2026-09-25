"""LoRA Studio の構図診断用タグ付け — WD タガー（CPU・onnxruntime）。

2026-09-25 導入（docs/STATUS.md「順番の改修」）。LoRA Studio の順番を
「ドロップ → 特徴確定 → 構図診断 → クロップ → キャプション（有料）→ 学習回数 → キュレーション → 学習」
に変えたため、キャプションより前に構図（距離・向き・仰角・姿勢・背景）を判定する材料が要る。
WD タガーは Danbooru の定番タグ（full body / upper body / from behind / sitting / simple background …）を
そのまま出すので、診断（src/lib/datasetDiagnostics.ts）の語彙と一致する。無料で出すので GPU は使わない。

構成（modal_caption_worker.py と同じ形）:
  - tag_dispatch（CPU・軽量）: Next.js から受けて tag_run を spawn する。
  - tag_run（CPU・軽量）: 画像を CHUNK 枚ずつ WdTagger.tag へ map し、途中結果を modal.Dict に書く。
  - WdTagger（CPU 8 コア）: R2 の縮小画像を読んでタグ付けする。モデルは image に焼き込む（起動を速くするため）。
  - tag_status（CPU・軽量）: 進み具合と途中結果を返す。

モデル / 依存（docs/model-licenses.md）:
  - SmilingWolf/wd-eva02-large-tagger-v3（Apache-2.0、ONNX）。確認 2026-09-25。
  - onnxruntime（MIT）。CPU 約 1 秒/枚（docs/gpu-benchmarks.md §17）。
"""

import os
import time

import fastapi
import modal

app = modal.App("ull-wd-tagger")

REPO = "SmilingWolf/wd-eva02-large-tagger-v3"
MODEL_DIR = "/opt/wd"
THRESHOLD = 0.35
# 1 コンテナに渡す枚数と、同時に立てる台数（2026-09-25 見直し）。CPU は「確保したコア × 時間」で課金され、
# 12 枚ずつ・最大 16 台・終了後 60 秒待機では、待機と起動の分が本処理（145 枚で約 1,600 コア秒 ≈ $0.02）を
# 大きく上回り、1 回 $0.1〜0.27 かかっていた（ホスト報告、docs/gpu-benchmarks.md の CPU 課金の節）。
# 台数を絞って 1 台あたりを増やし、終わったら 2 秒で止める。145 枚で 5 台・1 分弱の見込み。
CHUNK = 32
MAX_CONTAINERS = 6
MAX_IMAGES = 500
KAOMOJI = {"0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<", "3_3", "6_9", ">_o",
           "@_@", "^_^", "o_o", "u_u", "x_x", "|_|", "||_||"}

jobs = modal.Dict.from_name("ull-wd-tag-jobs", create_if_missing=True)


def _download_model() -> None:
    from huggingface_hub import hf_hub_download

    for name in ("model.onnx", "selected_tags.csv"):
        hf_hub_download(REPO, name, local_dir=MODEL_DIR)


cpu_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install("onnxruntime", "numpy", "pillow", "huggingface_hub", "boto3>=1.35", "fastapi[standard]")
    .run_function(_download_model)
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


@app.cls(
    image=cpu_image,
    cpu=8.0,
    memory=6144,
    timeout=10 * 60,
    # 終わったら 2 秒で止める（上のコメント参照。8 コア × 台数分の待機課金を残さない）。
    scaledown_window=2,
    max_containers=MAX_CONTAINERS,
    retries=0,
    secrets=[modal.Secret.from_name("r2-artifacts")],
)
class WdTagger:
    @modal.enter()
    def load(self):
        import csv

        import onnxruntime as ort

        t0 = time.time()
        with open(f"{MODEL_DIR}/selected_tags.csv", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        self.names = [r["name"] for r in rows]
        self.cats = [int(r["category"]) for r in rows]
        self.sess = ort.InferenceSession(f"{MODEL_DIR}/model.onnx", providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0]
        self.size = int(self.inp.shape[1])
        # R2 クライアントはスレッドから同時に作らせない（2026-09-25、8 スレッドが同時に作って 1 本が 600 秒止まった）。
        import ull_r2

        ull_r2.client()
        print(f"[wd] model ready in {time.time() - t0:.1f}s", flush=True)

    def _prep(self, data: bytes):
        import io

        import numpy as np
        from PIL import Image

        im = Image.open(io.BytesIO(data)).convert("RGB")
        side = max(im.size)
        canvas = Image.new("RGB", (side, side), (255, 255, 255))
        canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
        canvas = canvas.resize((self.size, self.size), Image.BICUBIC)
        return np.asarray(canvas, dtype=np.float32)[:, :, ::-1]  # RGB -> BGR（WD タガー公式の前処理）

    def _tags(self, probs) -> str:
        general = [(self.names[i], float(p)) for i, p in enumerate(probs) if self.cats[i] == 0 and p >= THRESHOLD]
        general.sort(key=lambda x: -x[1])
        return ", ".join(n if n in KAOMOJI else n.replace("_", " ") for n, _ in general)

    def tag_bytes(self, blobs: list[bytes | None]) -> list[str | None]:
        import numpy as np

        arrs, idx = [], []
        for i, b in enumerate(blobs):
            if b is None:
                continue
            try:
                arrs.append(self._prep(b))
                idx.append(i)
            except Exception as exc:  # noqa: BLE001 — その 1 枚だけ空で返す
                print(f"[wd] decode failed #{i}: {exc!r}", flush=True)
        out: list[str | None] = [None] * len(blobs)
        if arrs:
            probs = self.sess.run(None, {self.inp.name: np.stack(arrs)})[0]
            for i, p in zip(idx, probs):
                out[i] = self._tags(p)
        return out

    @modal.method()
    def tag(self, keys: list[str]) -> list[str | None]:
        from concurrent.futures import ThreadPoolExecutor

        import ull_r2

        def _fetch(k: str):
            try:
                return ull_r2.get_bytes(k)
            except Exception as exc:  # noqa: BLE001
                print(f"[wd] fetch failed {k}: {exc!r}", flush=True)
                return None

        t0 = time.time()
        with ThreadPoolExecutor(max_workers=8) as ex:
            blobs = list(ex.map(_fetch, keys))
        t1 = time.time()
        out = self.tag_bytes(blobs)
        print(f"[wd] {len(keys)} imgs: fetch {t1 - t0:.1f}s, tag {time.time() - t1:.1f}s", flush=True)
        return out

    @modal.method()
    def probe(self, blobs: list[bytes]) -> list[str | None]:
        """CPU 確認用（modal run modal_wd_tagger.py::probe_local）。"""
        t0 = time.time()
        out = self.tag_bytes(blobs)
        print(f"[wd] probe {len(blobs)} imgs in {time.time() - t0:.1f}s", flush=True)
        return out


@app.function(
    image=cpu_image,
    timeout=15 * 60,
    scaledown_window=2,
    retries=0,
    secrets=[modal.Secret.from_name("r2-artifacts")],
)
def tag_run(job: dict) -> dict:
    import ull_r2

    key = job["dict_key"]
    keys: list[str] = job["keys"]
    total = len(keys)
    state = {"status": "running", "done": 0, "total": total, "tags": [None] * total, "started_at": time.time()}
    jobs[key] = state
    t0 = time.time()
    try:
        chunks = [keys[s:s + CHUNK] for s in range(0, total, CHUNK)]
        for n, res in enumerate(WdTagger().tag.map(chunks, order_outputs=True)):
            for j, t in enumerate(res):
                state["tags"][n * CHUNK + j] = t
            state["done"] = min(total, (n + 1) * CHUNK)
            jobs[key] = state
        state.update({"status": "completed", "done": total, "elapsed_s": round(time.time() - t0, 1)})
        jobs[key] = state
        print(f"[wd] {key} {total} imgs in {state['elapsed_s']}s", flush=True)
    except Exception as exc:  # noqa: BLE001
        state.update({"status": "failed", "error": f"{type(exc).__name__}: {exc}"[:500]})
        jobs[key] = state
        print(f"[wd] {key} FAILED: {exc!r}", flush=True)
    finally:
        try:
            ull_r2.delete_keys(keys)  # 縮小画像はタグ付けが済めば要らない
        except Exception as exc:  # noqa: BLE001
            print(f"[wd] input cleanup skipped: {exc!r}", flush=True)
    return {"status": state["status"], "total": total}


@app.function(
    image=endpoint_image,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
    timeout=60,
    scaledown_window=2,
)
@modal.fastapi_endpoint(method="POST")
def tag_dispatch(body: dict, request: fastapi.Request):
    _authorize(request)
    key = str(body.get("dict_key") or "")
    keys = body.get("keys") or []
    if not key or not isinstance(keys, list) or not keys or len(keys) > MAX_IMAGES:
        raise fastapi.HTTPException(status_code=400, detail="invalid job")
    jobs[key] = {"status": "queued", "done": 0, "total": len(keys), "tags": [None] * len(keys),
                 "queued_at": time.time()}
    call = tag_run.spawn({"dict_key": key, "keys": [str(k) for k in keys]})
    return {"ok": True, "call_id": call.object_id}


@app.function(
    image=endpoint_image,
    secrets=[modal.Secret.from_name("wan-animate-auth")],
    timeout=30,
    scaledown_window=2,
)
@modal.fastapi_endpoint(method="GET")
def tag_status(dict_key: str, request: fastapi.Request):
    _authorize(request)
    st = jobs.get(dict_key)
    if not st:
        return {"status": "unknown"}
    return st


@app.local_entrypoint()
def probe_local(paths: str = ""):
    """CPU 確認: `modal run modal_wd_tagger.py --paths a.png,b.jpg`（GPU は使わない）。"""
    import pathlib

    files = [pathlib.Path(p) for p in paths.split(",") if p.strip()]
    blobs = [f.read_bytes() for f in files]
    for f, t in zip(files, WdTagger().probe.remote(blobs)):
        print(f"{f.name}: {t}")
