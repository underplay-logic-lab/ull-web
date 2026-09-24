"""既存ジョブのキャプション本文を WD タガーのタグに差し替える（2026-09-24、v7 比較用）。

先頭の「トリガー＋人数・性別タグ」（keep_tokens_per_image 個）は元のキャプションのまま残し、
本文だけを WD タガー（eva02-large, Apache-2.0）のタグにする。本文から次を除く:
  - 元ジョブで確定した特徴（dispatch.embed_tags。トリガーに覚えさせる言葉なので書かない）
  - その言い換え（IDENTITY_SYNONYM_PATTERNS。fat man / old man / grey-framed eyewear 等）
  - WD の人数・性別タグ（1girl / 1boy / solo 等。先頭ブロックと重複・矛盾するため）

    python scripts/wd_rebuild_captions.py <job.json> <image_dir> <out.json> [general_threshold]

job.json は generation_jobs の行（select=inputs,metadata）の JSON 配列。画像は storage_paths の
ファイル名で image_dir から引く。CPU で動く。
"""
import json
import os
import re
import sys
import time

from wd_tagger_compare import KAOMOJI, load, prep

# 確定した特徴（embed_tags）の「言い換え」を WD が出してくる分（2026-09-24、v7 の 220 枚で確認）。
# 被写体固有の外見（体型・年齢・髪の長さ・目の色・胸・眼鏡・肌）なので、書くとトリガーに入らない。
# ugly man は「女性っぽくなる」問題の真因がネガティブ「醜い」だった件（メモリ参照）もあり必ず外す。
# 表情（half-closed eyes, closed eyes 等）は外見ではないので残す。
IDENTITY_SYNONYM_PATTERNS = [
    r"^(fat|old|ugly|mature|middle-aged) (man|male|female|woman)$", r"^old$", r"^fat$", r"^ugly$",
    r"^(flat chest|breasts|small breasts|medium breasts|large breasts|huge breasts)$",
    r"^(very short|short|medium|long|very long) hair$", r"^(black|brown|blue|grey|red|green|purple|pink) eyes$",
    r"eyewear$", r"^glasses$", r"^(wrinkled skin|wrinkles|facial hair|beard|stubble|mustache|double chin)$",
    r"^(lips|red lips|thick lips)$", r"^(bald|baldness)$", r"^(plump|chubby|obese|thick eyebrows)$",
]

COUNT_TAGS = {
    "1girl", "2girls", "3girls", "multiple girls", "1boy", "2boys", "3boys", "multiple boys",
    "solo", "solo focus", "1other", "male focus", "female focus",
}


def split_tags(s):
    return [t.strip() for t in s.split(",") if t.strip()]


def main():
    job_path, image_dir, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    thr = float(sys.argv[4]) if len(sys.argv) > 4 else 0.35
    job = json.load(open(job_path, encoding="utf-8"))[0]
    d = job["inputs"]["dispatch"]
    paths, caps, keeps = d["storage_paths"], d["custom_captions"], d["keep_tokens_per_image"]
    identity = {t.lower() for t in split_tags(d.get("embed_tags") or "")}

    sess, names, cats = load()
    inp = sess.get_inputs()[0]
    size = inp.shape[1]
    out = []
    t0 = time.time()
    for i, p in enumerate(paths):
        f = os.path.join(image_dir, os.path.basename(p))
        probs = sess.run(None, {inp.name: prep(f, size)})[0][0]
        tags = [(names[k], float(v)) for k, v in enumerate(probs) if cats[k] == 0 and v >= thr]
        tags.sort(key=lambda x: -x[1])
        wd = [n if n in KAOMOJI else n.replace("_", " ") for n, _ in tags]
        head = split_tags(caps[i])[: keeps[i]]
        head_l = {t.lower() for t in head}
        syn = [re.compile(x) for x in IDENTITY_SYNONYM_PATTERNS]
        body = [
            t for t in wd
            if t.lower() not in identity and t.lower() not in COUNT_TAGS and t.lower() not in head_l
            and not any(r.search(t.lower()) for r in syn)
        ]
        out.append({"i": i, "path": p, "old": caps[i], "new": ", ".join(head + body), "wd_raw": wd})
    dt = time.time() - t0
    json.dump({"threshold": thr, "seconds": dt, "identity_removed": sorted(identity), "items": out},
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{len(out)} images in {dt:.0f}s ({dt / len(out):.2f}s/img, CPU)")


if __name__ == "__main__":
    main()
