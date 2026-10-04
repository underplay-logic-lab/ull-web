"""10Eros（MiniMax H3 の LoRA 焼き込みモデル）の bf16 を、公式 pruned bf16 と同じ入れ物に直す。CPU のみ（GPU 課金なし）。

なぜ（2026-10-05）: ひなた LoRA は 10Eros の上ではほぼ効かない（10Eros は説明欄に「H3 LoRA merge」＝LoRA 焼き込み済み）。
10Eros を土台に LoRA を学習するため、LoRA ワーカーが直接読む公式 `minimax_h3_fl2va_pruned_bf16` と同じ形にする。
Volume 上の 2 ファイルはキー 532 個・形が完全一致で、違いは ①10Eros だけの余りキー 2 個（adaln_basis / adaln_mean。
ComfyUI 本体のコードは参照しない）②112 個の小さなテンソルの dtype（公式は F16/F32、10Eros は全部 BF16）だけ。
→ 余りキーを外すだけ。dtype は 10Eros の BF16 のまま（ローダーが読むときにモデル側の dtype へ変換する）。
  公式に合わせて F16 にすると adaln_proj の bias のごく小さい値が F16 の範囲外で桁落ちした（2026-10-05 に確認）→ 変えない。
変換後、全テンソルが元とビット一致することを確かめる。Director もこのファイルを使い、確認後に元ファイルと付け替える。

  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run scripts/modal_10eros_h3keys.py                # 変換＋ビット一致の確認
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal run scripts/modal_10eros_h3keys.py --step swap    # 確認後: 元の名前へ付け替え
"""
import json
import os
import struct
import time

import modal

app = modal.App("ull-10eros-h3keys")
vol = modal.Volume.from_name("ull-wan-models")
image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install("torch", index_url="https://download.pytorch.org/whl/cpu")
    .pip_install("safetensors", "numpy")
)
DIR = "/models/diffusion_models"
SRC = f"{DIR}/10Eros_Max_h3_hybrid_beta5.safetensors"
REF = f"{DIR}/minimax_h3_fl2va_pruned_bf16.safetensors"
DST = f"{DIR}/10Eros_Max_h3_hybrid_beta5_h3keys_bf16.safetensors"
DROP = {"adaln_basis", "adaln_mean"}
BUF = 4 * 1024 * 1024  # Volume は 4MiB 単位で書く（CLAUDE.md §1）
ST_DTYPE = {"BF16": "bfloat16", "F16": "float16", "F32": "float32"}
ST_SIZE = {"BF16": 2, "F16": 2, "F32": 4}


def _header(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        h = json.loads(f.read(n))
    meta = h.pop("__metadata__", {})
    return h, meta


@app.function(image=image, volumes={"/models": vol}, cpu=4, memory=16384, timeout=3600, scaledown_window=2)
def convert() -> dict:
    import torch
    from safetensors import safe_open

    t0 = time.time()
    src_h, src_meta = _header(SRC)
    ref_h, _ = _header(REF)
    keys = [k for k in src_h if k not in DROP]
    assert set(keys) == set(ref_h), "キーの集合が公式と一致しない"
    for k in keys:
        assert src_h[k]["shape"] == ref_h[k]["shape"], f"形が違う: {k}"

    # 出力ヘッダー（公式の dtype・元の並び順）
    header, off = {}, 0
    for k in keys:
        dt = src_h[k]["dtype"]
        n = ST_SIZE[dt]
        for s in src_h[k]["shape"]:
            n *= s
        header[k] = {"dtype": dt, "shape": src_h[k]["shape"], "data_offsets": [off, off + n]}
        off += n
    header["__metadata__"] = {
        "format": "pt",
        "converted_from": os.path.basename(SRC),
        "source_description": str(src_meta.get("description", "")),
        "note": "ULL: dropped adaln_basis/adaln_mean only (unused by ComfyUI); all tensors bit-identical to the source",
    }
    hb = json.dumps(header, separators=(",", ":")).encode("utf-8")
    hb += b" " * ((8 - len(hb) % 8) % 8)

    changed, f16_max = 0, 0.0
    tmp = DST + ".part"
    with safe_open(SRC, "pt") as src, open(tmp, "wb", buffering=BUF) as out:
        out.write(struct.pack("<Q", len(hb)))
        out.write(hb)
        for k in keys:
            t = src.get_tensor(k)
            want = getattr(torch, ST_DTYPE[src_h[k]["dtype"]])
            if t.dtype != want:
                changed += 1
                if want == torch.float16:
                    f16_max = max(f16_max, float(t.float().abs().max()))
                    assert torch.isfinite(t.to(torch.float16)).all(), f"F16 の範囲外: {k}"
                t = t.to(want)
            out.write(t.contiguous().view(torch.uint8).numpy().tobytes())
    os.replace(tmp, DST)
    vol.commit()
    wrote = time.time() - t0

    # ビット一致の確認: 変換後を BF16 に戻して元と比べる
    mism = []
    with safe_open(SRC, "pt") as a, safe_open(DST, "pt") as b:
        for k in keys:
            ta, tb = a.get_tensor(k), b.get_tensor(k)
            if ta.dtype != tb.dtype or not torch.equal(ta, tb):
                mism.append(k)
    res = {
        "keys": len(keys), "dtype_changed": changed, "f16_max_abs": f16_max,
        "bit_identical": not mism, "mismatch": mism[:10],
        "gb": round(os.path.getsize(DST) / 1e9, 2), "write_s": round(wrote), "total_s": round(time.time() - t0),
    }
    print(f"[10eros] {res}", flush=True)
    return res


EXTRA = f"{DIR}/10Eros_Max_h3_hybrid_beta5_extra_keys.safetensors"


@app.function(image=image, volumes={"/models": vol}, cpu=2, memory=4096, timeout=1800, scaledown_window=2)
def swap() -> dict:
    """convert で bit_identical を確かめた後に 1 回だけ。元ファイルにしか無い 2 キーを小さなファイルに残し
    （元に戻すときは変換版にこれを足して dtype を BF16 に戻せばビット一致）、変換版を元の名前に付け替える。
    Director は元の名前のまま読むのでコードの変更は要らない。実行中の Director ジョブが無いときに走らせる。"""
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file

    if not os.path.isfile(DST):
        return {"ok": False, "reason": "変換版がありません（先に convert）"}
    src_h, _ = _header(SRC)
    if not DROP <= set(src_h):
        return {"ok": False, "reason": "元ファイルは既に置き換え済みのようです"}
    with safe_open(SRC, "pt") as f:
        save_file({k: f.get_tensor(k) for k in DROP}, EXTRA, metadata={"note": "10Eros の余りキー（ComfyUI は未使用）。元に戻す用"})
    os.remove(SRC)
    os.replace(DST, SRC)
    vol.commit()
    return {"ok": True, "now": SRC, "extra_keys": EXTRA, "gb": round(os.path.getsize(SRC) / 1e9, 2)}


@app.local_entrypoint()
def main(step: str = "convert"):
    fn = {"convert": convert, "swap": swap}[step]
    print(json.dumps(fn.remote(), ensure_ascii=False))
