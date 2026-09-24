"""WD タガー（SmilingWolf/wd-eva02-large-tagger-v3, Apache-2.0）で比較用の画像をタグ付けする（2026-09-24）。

scripts/caption_model_compare.ts と同じ manifest（長辺 640 JPEG）を読み、Gemini の結果 JSON に
"wd-eva02-large" として結果を足して書き出す。CPU（onnxruntime）で動くので GPU 費用はかからない。

    python scripts/wd_tagger_compare.py <manifest.json> <cmp_result.json> [trigger] [general_threshold]

前処理は WD タガー公式の手順（白でパディングして正方形 → 448px → BGR float32、NHWC）。
タグの "_" は空白に置き換える（Illustrious 系の学習キャプションの通例。顔文字タグは除く）。
"""
import csv
import json
import sys
import time

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from PIL import Image

REPO = "SmilingWolf/wd-eva02-large-tagger-v3"
KAOMOJI = {"0_0", "(o)_(o)", "+_+", "+_-", "._.", "<o>_<o>", "<|>_<|>", "=_=", ">_<", "3_3", "6_9", ">_o", "@_@", "^_^", "o_o", "u_u", "x_x", "|_|", "||_||"}


def load():
    model_path = hf_hub_download(REPO, "model.onnx")
    tags_path = hf_hub_download(REPO, "selected_tags.csv")
    with open(tags_path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    names = [r["name"] for r in rows]
    cats = [int(r["category"]) for r in rows]
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    return sess, names, cats


def prep(path, size):
    im = Image.open(path).convert("RGB")
    side = max(im.size)
    canvas = Image.new("RGB", (side, side), (255, 255, 255))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    canvas = canvas.resize((size, size), Image.BICUBIC)
    arr = np.asarray(canvas, dtype=np.float32)[:, :, ::-1]  # RGB -> BGR
    return np.expand_dims(arr, 0)


def main():
    manifest_path, result_path = sys.argv[1], sys.argv[2]
    trigger = sys.argv[3] if len(sys.argv) > 3 else "yukipas"
    thr = float(sys.argv[4]) if len(sys.argv) > 4 else 0.35
    sess, names, cats = load()
    inp = sess.get_inputs()[0]
    size = inp.shape[1]
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    rows = []
    t0 = time.time()
    for m in manifest:
        probs = sess.run(None, {inp.name: prep(m["path"], size)})[0][0]
        general = [(names[i], p) for i, p in enumerate(probs) if cats[i] == 0 and p >= thr]
        general.sort(key=lambda x: -x[1])
        tags = [n if n in KAOMOJI else n.replace("_", " ") for n, _ in general]
        rows.append({"name": m["name"], "en": ", ".join([trigger] + tags), "ja": ""})
    dt = time.time() - t0
    data = json.load(open(result_path, encoding="utf-8"))
    data["result"]["wd-eva02-large"] = rows
    json.dump(data, open(result_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(rows)} images in {dt:.1f}s ({dt / len(rows):.2f}s/img, CPU), threshold {thr}")


if __name__ == "__main__":
    main()
