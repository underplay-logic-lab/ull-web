"""温まり返金（2026-10-10）の共通部品。GPU ワーカー（顔入れ替え・曲・Director 系・超解像）が import する。

送信時は今までどおり全額を引き、同じモデルを載せたままのコンテナで動いたら（続けて作った・予約の順番が来た）、完了時に
「実際にかかった秒数 × 単価」で計算し直して差額を返す。上限は基本料のうち起動・読み込みの分。Next 側は src/lib/pricing/warmRefund.ts
（warm_settle = {cap, compare_credits, credits_per_s} をジョブに載せる）。返した額は metadata.warm_refund_credits に残し、
generation_logs の売上から差し引く（migration 20260902000000）。

対象外: LoRA 学習（scaledown_window=2 で温まる状況が無い）。失敗したジョブは各ワーカーの全額返金なので関係しない。
"""

_MODEL_LOADER_TYPES = ("UNETLoader", "CLIPLoader", "DualCLIPLoader", "VAELoader", "CheckpointLoaderSimple")


def settle_refund(user_id: str, settle, credits_cost: int, warm: bool, actual_s: float, refund_fn) -> int:
    """返す額 = min(cap, 料金, 通常料金 − 実際の秒数 × 単価)。温まっていなければ 0。返した額（0 か正）を返す。

    文章 AI・TE など温まっていても毎回読み直す分は実際の秒数に入るので、返す額は自動で減る。
    refund_fn(user_id, n) は各ワーカーの返金（DB の refund_profile_credits）。"""
    if not warm or not isinstance(settle, dict):
        return 0
    try:
        cap = int(settle.get("cap") or 0)
        compare = float(settle.get("compare_credits") or 0)
        rate = float(settle.get("credits_per_s") or 0)
    except (TypeError, ValueError):
        return 0
    n = int(min(cap, int(credits_cost or 0), max(0.0, compare - max(0.0, float(actual_s)) * rate)))
    if n <= 0:
        return 0
    refund_fn(user_id, n)
    return n


def model_signature(workflow: dict) -> tuple:
    """ComfyUI のワークフローの本体モデル（UNET・文章読み取り・VAE）の組み合わせ。前に成功したジョブと同じなら、
    （ComfyUI を起動し直していない限り）重みは載ったまま＝温まっている。LoRA は読み込みが軽いので入れない。"""
    sig = []
    for node in workflow.values():
        if isinstance(node, dict) and node.get("class_type") in _MODEL_LOADER_TYPES:
            ins = node.get("inputs") or {}
            sig.append((node["class_type"], *(str(v) for _k, v in sorted(ins.items()) if isinstance(v, (str, int, float)))))
    return tuple(sorted(sig))
