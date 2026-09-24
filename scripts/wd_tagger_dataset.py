"""データセット全体を WD タガーで解析し、「大半の画像に共通して出るタグ＝キャラの特徴」を除いた
キャプションを作る試作（2026-09-24）。CPU で動く。元フォルダには何も書かない。

    python scripts/wd_tagger_dataset.py <image_dir> <out.json> [trigger] [general_threshold] [identity_ratio]

- general_threshold（既定 0.35）: このスコア以上のタグを採用（WD タガーの通例）。
- identity_ratio（既定 0.5）: 全画像のこの割合以上に出るタグを「特徴」とみなしてキャプションから外す。
  トリガーワードがその特徴を覚えるようにするため（Gemini の指示文「特徴は書かない」と同じ狙い）。
  クロップ（顔・足だけ等）が混ざると衣装のタグは出現率が下がるので、既定を 0.5 にしている。
"""
import json
import os
import sys
import time
from collections import Counter

from wd_tagger_compare import KAOMOJI, load, prep


def main():
    src, out_path = sys.argv[1], sys.argv[2]
    trigger = sys.argv[3] if len(sys.argv) > 3 else "yukipas"
    thr = float(sys.argv[4]) if len(sys.argv) > 4 else 0.35
    ratio = float(sys.argv[5]) if len(sys.argv) > 5 else 0.5

    sess, names, cats = load()
    inp = sess.get_inputs()[0]
    size = inp.shape[1]
    files = sorted(f for f in os.listdir(src) if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")))

    per_image = []
    t0 = time.time()
    for f in files:
        probs = sess.run(None, {inp.name: prep(os.path.join(src, f), size)})[0][0]
        tags = [(names[i], float(p)) for i, p in enumerate(probs) if cats[i] == 0 and p >= thr]
        tags.sort(key=lambda x: -x[1])
        per_image.append({"name": f, "tags": [n if n in KAOMOJI else n.replace("_", " ") for n, _ in tags]})
    dt = time.time() - t0

    freq = Counter(t for im in per_image for t in set(im["tags"]))
    n = len(per_image)
    identity = sorted((t for t, c in freq.items() if c / n >= ratio), key=lambda t: -freq[t])
    for im in per_image:
        kept = [t for t in im["tags"] if t not in identity]
        im["caption"] = ", ".join([trigger] + kept)

    json.dump(
        {
            "trigger": trigger,
            "threshold": thr,
            "identity_ratio": ratio,
            "seconds": dt,
            "freq": {t: c for t, c in freq.most_common()},
            "identity": identity,
            "images": per_image,
        },
        open(out_path, "w", encoding="utf-8"),
        ensure_ascii=False,
        indent=1,
    )
    print(f"{n} images in {dt:.0f}s ({dt / n:.2f}s/img, CPU)")
    print(f"identity (>= {ratio:.0%} of images, removed from captions): {len(identity)}")
    for t in identity:
        print(f"  {freq[t] / n:5.0%}  {t}")
    print("next most frequent (kept in captions):")
    for t, c in freq.most_common():
        if t not in identity and c / n >= 0.2:
            print(f"  {c / n:5.0%}  {t}")


if __name__ == "__main__":
    main()
