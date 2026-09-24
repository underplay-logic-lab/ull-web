"""LoRA 学習の GPU tier 確認ジョブを 1 本投げる（クレジット引き落とし無し）。

既存ジョブの dispatch payload を DB から複製し、gpu_tier だけ差し替えて同じ dispatch エンドポイントへ
投げる（docs/gpu-benchmarks.md §14.26 の手順）。新しい行の inputs.tier_probe に出典を記録する。

    python scripts/lora_tier_probe.py <source_job_id> <gpu_tier> [--note "..."]

gpu_tier は Next 側の tier id（b300 / b200 / h200 / h100 / rtx_pro_6000 / a100_80gb / l40s）。
⚠️ GPU 課金が発生する。実行前にホストの承認を取ること（CLAUDE.md §1・メモリ gpu-experiment-cost-discipline）。
"""
import argparse
import json
import os
import urllib.request
import uuid
from datetime import date

TIERS = {"b300", "b200", "h200", "h100", "rtx_pro_6000", "a100_80gb", "l40s"}

# シェルに依存しないよう .env.local を自前で読む。
_ENV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.local")
with open(_ENV, encoding="utf-8") as _f:
    for _line in _f:
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _v = _line.split("=", 1)
        os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

U = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
H = {"apikey": K, "Authorization": "Bearer " + K, "Content-Type": "application/json"}


def req(url, method="GET", body=None, headers=H):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(url, method=method, data=data, headers=headers)
    with urllib.request.urlopen(r, timeout=60) as f:
        raw = f.read()
    return json.loads(raw) if raw else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source_job")
    ap.add_argument("gpu_tier", choices=sorted(TIERS))
    ap.add_argument("--note", default="")
    a = ap.parse_args()

    rows = req(f"{U}/rest/v1/generation_jobs?select=user_id,inputs,workflow_type&id=eq.{a.source_job}")
    if not rows:
        raise SystemExit(f"source job not found: {a.source_job}")
    src = rows[0]
    inputs = src["inputs"]
    d = dict(inputs["dispatch"])
    worker = inputs.get("worker")
    url = os.environ["MODAL_SDXL_LORA_TRAIN_URL" if worker == "sdxl" else "MODAL_LORA_TRAIN_URL"]

    d["gpu_tier"] = a.gpu_tier
    d["output_lora_name"] = f"{d.get('output_lora_name', 'probe')}_{a.gpu_tier}"[:120]
    inputs.update(
        dispatch=d,
        output_lora_name=d["output_lora_name"],
        tier_probe={
            "note": a.note or f"{date.today()} tier probe (no credit debit)",
            "tier": a.gpu_tier,
            "source_job": a.source_job,
        },
    )
    inputs.pop("modal_call_id", None)

    jid = str(uuid.uuid4())
    req(
        f"{U}/rest/v1/generation_jobs",
        "POST",
        {
            "id": jid,
            "user_id": src["user_id"],
            "status": "queued",
            "workflow_type": src["workflow_type"],
            "inputs": inputs,
            "credits_cost": 0,
            "progress_message": f"tier probe ({a.gpu_tier})",
        },
        {**H, "Prefer": "return=minimal"},
    )
    body = dict(d, job_id=jid, user_id=src["user_id"], credits_cost=0)
    res = req(url, "POST", body, {"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["MODAL_AUTH_TOKEN"]})
    print("job_id:", jid)
    print(res)


if __name__ == "__main__":
    main()
