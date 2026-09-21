"""
LoRA 学習の GPU tier / 解像度 / 枚数 ベンチマーク（Stage 1）。

**本番ワーカーではない** — 値付けの根拠を作るための計測専用スクリプト。

背景:
  LoRA の課金は 2026-09-20 に「推定GPU秒 × クレジット単価」へ作り直した
  （src/lib/pricing/loraRuntime.ts）。式の入力である
    - arch 別 s/it（LORA_SPI_BASELINE）
    - 解像度スケール指数（lora_res_scale_exponent）
    - 準備時間の固定分／1枚あたり（lora_prep_load_s / lora_prep_per_image_s）
  のうち、実測に裏付けられているのは sdxl の s/it だけで、残りは暫定値。
  さらに LoRA 学習は B300 一択で組んだ経緯があり（「高くても速ければ安い」
  という当初の想定）、docs/gpu-benchmarks.md §1 は「LoRA学習は80GB超要求、
  RTX PRO 6000(96GB) がまず試す価値のある候補、**未検証**」で止まっている。
  このスクリプトはその穴を埋める。

計測するのは3つだけ（品質評価は一切しない = 人の目が要らない）:
  1. 定常 s/it   … 単価の主項
  2. peak VRAM   … どの tier に載るかの可否判定
  3. 準備時間     … モデルロード（固定）と latent キャッシュ（枚数比例）の分解

学習設定は「VRAM をケチらず、しっかり焼ける設定」で測る（ホスト方針）:
  - optimizer は prodigy（full precision・LR-free）。adamw8bit のような
    int8 量子化オプティマイザは使わない（CLAUDE.md §1）。
  - quantize / low_vram が False であることを毎回コード側で検証し、
    True なら例外を投げて計測を中止する。
  - gradient_checkpointing は既定 OFF。production は True 固定のままなので、
    "settings" プランで on/off を A/B して切る判断の根拠を作る。

⚠️ tqdm の単位について:
  ai-toolkit の進捗行は速い時 "it/s"、遅い時 "s/it" と**単位が入れ替わる**。
  docs/gpu-benchmarks.md §5 の LoRA 計測値（2026-09-06）が実運用と25倍ずれて
  いるのは、ほぼ確実にこれが原因。このスクリプトは生のトークンをそのまま
  `tqdm_unit` として記録し、正規化後の `spi_*`（常に 秒/it）と併記するので、
  同じ取り違えは二度と起きない。

コスト規律（CLAUDE.md §0・§1、メモリ [[gpu-experiment-cost-discipline]]）:
  - `cpu_probe` がグリーンになるまで GPU は一切起動しない。
  - 監視・パーサのロジック確認は最安 tier（T4）の `harness_check` で先に済ませる。
  - `plan` は既定でドライラン。実行には明示的に --confirm が要る。
  - 各ランに壁時計の上限を持たせ、超えたら subprocess を kill する。
  - 全条件を総当たりしない。s/it は tier 係数と解像度係数に分離できると仮定し、
    分離が成り立つかを1点だけ交差検証する（下の PLAN 参照）。

使い方:
  modal run modal_lora_benchmark.py::cpu_probe
      GPUなし。import・config生成・データセット生成・ベース重みの存在確認。

  modal run modal_lora_benchmark.py::harness_check
      T4。VRAMサンプラと tqdm パーサが動くことだけを確認する（学習はしない）。

  modal run modal_lora_benchmark.py --plan default
      実行計画と概算コストを表示するだけ（ドライラン）。

  modal run modal_lora_benchmark.py --plan default --confirm
      実際に計測する。結果は1条件ごとに JSONL で
      bench_results/lora_stage1_<timestamp>.jsonl へ追記される。
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import threading
import time

import modal

# 本番ワーカーの image と config 生成をそのまま使う。環境（torch / CUDA /
# ai-toolkit のリビジョン / shim）が1ビットでも違うと tier 比較が不公平に
# なるため、複製せず import する（CLAUDE.md §0「比較実測の前に、対象コードが
# tier 間で公平になっているかをまず確認する」）。
import modal_lora_worker as W

app = modal.App("ull-lora-benchmark")

# ベンチ用 image = 本番 image + このファイル自身と本番ワーカーを同梱。
BENCH_IMAGE = W.image.add_local_python_source(
    "modal_lora_worker", "modal_lora_benchmark", "ull_image_prep"
)

SECRETS = [
    modal.Secret.from_name("supabase-model-downloads"),
    modal.Secret.from_name("wan-animate-auth"),
    modal.Secret.from_name("huggingface-secret"),
]

# Modal の $/h（knobDefaults.ts の gpu_usd_per_hour_* と同じ値）。概算コスト
# 表示にしか使わない — ユーザー向けUIには絶対に出さないこと（CLAUDE.md §2）。
TIER_USD_PER_HOUR = {
    "b300": 7.50,
    "b200": 6.25,
    "h200": 4.54,
    "rtx_pro_6000": 3.03,
    "l40s": 1.95,
    "t4": 0.59,
}

# Modal の gpu= に渡す文字列。
TIER_GPU = {
    "b300": "b300",
    "b200": "b200",
    "h200": "h200",
    "rtx_pro_6000": "rtx-pro-6000",
    "l40s": "l40s",
    "t4": "t4",
}


# ---------------------------------------------------------------------------
# 計測条件
# ---------------------------------------------------------------------------
# s/it(tier, 解像度) ≈ s/it基準(解像度) × k(tier) と分離できると仮定して、
# 総当たり（tier×解像度×arch）を避ける。
#   1-3. b300 × 768/1024/1280        → 解像度スケール（指数 knob の根拠）
#   4.   h200 × 1024                 → tier 係数
#   5.   rtx_pro_6000 × 1024         → tier 係数
#   6.   rtx_pro_6000 × 1280         → 分離仮定の交差検証 ＋ **96GBに載るかの本命確認**
#   7-8. b300 × 1024 × 枚数10/60     → prep の固定分と1枚あたりを分離
#
# arch は2つ:
#   minimax_h3  … 一番重く VRAM 上限を決める。動画LoRAの価格を左右する。
#   qwen_image  … 画像系の代表。現行 2.0 s/it 想定で最も原価割れしている。
DEFAULT_IMAGES = 24

# 学習設定の既定 —「VRAM をケチらず、しっかり焼ける設定」で測る（ホスト方針、
# 2026-09-20）。ここを production と揃えないと、出てきた s/it で値付けしても
# 実際の課金対象と一致しない。
#
#  optimizer=prodigy:
#    full precision かつ learning-rate-free。adamw8bit（bitsandbytes の int8
#    量子化オプティマイザ）は VRAM 節約のための量子化で、CLAUDE.md §1 の
#    量子化禁止に抵触する上、Blackwell の VRAM では使う理由が無い。
#    ai-toolkit ワーカーの既定は 2026-09-14 に prodigy へ修正済み。
#
#  gradient_checkpointing=False:
#    ⚠️ production（modal_lora_worker.py:1833 / modal_sdxl_lora_worker.py:386）
#    は **True のまま**。これは activation を捨てて backward で再計算する
#    VRAM 節約策で、一般に 20〜40% 遅くなる。LoRA はアダプタしか学習せず、
#    B300 の 288GB に対して明らかに過剰な節約。オフにできるなら s/it が直接
#    下がり、原価がそのまま下がる（＝価格を下げられる）。
#    このベンチは on/off を A/B して、切る判断の根拠を作る。
DEFAULT_TRAIN_SETTINGS = {
    "optimizer": "prodigy",
    "gradient_checkpointing": False,
}

PLANS: dict[str, list[dict]] = {
    # まず本命だけ。minimax_h3 の tier 比較と VRAM 可否。
    "tiers": [
        {"tier": "b300", "target_model": "minimax_h3", "resolution": 1024},
        {"tier": "h200", "target_model": "minimax_h3", "resolution": 1024},
        {"tier": "rtx_pro_6000", "target_model": "minimax_h3", "resolution": 1024},
        {"tier": "rtx_pro_6000", "target_model": "minimax_h3", "resolution": 1280},
    ],
    # 解像度スケール指数の根拠。
    "resolution": [
        {"tier": "b300", "target_model": "minimax_h3", "resolution": 768},
        {"tier": "b300", "target_model": "minimax_h3", "resolution": 1024},
        {"tier": "b300", "target_model": "minimax_h3", "resolution": 1280},
    ],
    # prep の固定分 / 1枚あたりの分解（同一 tier・同一解像度で枚数だけ振る）。
    "prep": [
        {"tier": "b300", "target_model": "minimax_h3", "resolution": 1024, "images": 10},
        {"tier": "b300", "target_model": "minimax_h3", "resolution": 1024, "images": 60},
    ],
    # 画像系の代表。
    "image_arch": [
        {"tier": "b300", "target_model": "qwen_image", "resolution": 1024},
        {"tier": "rtx_pro_6000", "target_model": "qwen_image", "resolution": 1024},
    ],
    # gradient_checkpointing の A/B。production は True のままなので、切って
    # どれだけ速くなり VRAM がどれだけ増えるかを測る。VRAM が tier の上限に
    # 収まるなら、切るだけで原価が下がる。
    "settings": [
        {"tier": "b300", "target_model": "minimax_h3", "resolution": 1024,
         "gradient_checkpointing": True},
        {"tier": "b300", "target_model": "minimax_h3", "resolution": 1024,
         "gradient_checkpointing": False},
    ],
}
# 軽い画像系 arch を B300 から降ろせるかの判定。見るのは peak VRAM（その tier に
# 載るか）と s/it（どれだけ遅くなるか）の2つだけ。B300 ¥1,125/h に対し
# L40S は ¥292.5/h なので、VRAM さえ足りれば原価が約4分の1になる。
# flux2_klein_4b(4B) は現行ラインナップで最軽量＝一番降ろせる見込みが高い。
#
# ⚠️ 「sd-scripts の方が安い」は誤った因果（2026-09-20）。sd-scripts(SDXL) の
# prep 43秒 と ai-toolkit の 550秒 の差は、trainer ではなく (a) GPU tier
# （L40S vs B300 で 3.8倍）、(b) torch.compile ウォームアップ、(c) minimax_h3
# 固有の逆量子化、から来ている。trainer を乗り換えるのではなく tier を下げる
# のが正しい打ち手で、それを確かめるのがこのプラン。
PLANS["image_tier"] = [
    {"tier": "b300", "target_model": "flux2_klein_4b", "resolution": 1024, "images": 8,
     "warmup_steps": 10, "measure_steps": 40},
    {"tier": "rtx_pro_6000", "target_model": "flux2_klein_4b", "resolution": 1024, "images": 8,
     "warmup_steps": 10, "measure_steps": 40},
    {"tier": "l40s", "target_model": "flux2_klein_4b", "resolution": 1024, "images": 8,
     "warmup_steps": 10, "measure_steps": 40},
]

# ホストが実案件（yukipas_v5, 2026-09-04）で使った実設定の再現。
#
# 私の smoke は rank32 / 実効バッチ1 / gc無効 で peak 107.4GB だったが、
# ホストの実設定は rank64 / 実効バッチ4（batch2 × grad_accum2）/ **gc有効**で
# peak 約185GB だった。つまり「288GBに対して余裕がある」という私の判断は、
# 軽い条件での数字に基づいた誤りだった。
#
# 知りたいのは1つ: **実設定で gradient_checkpointing を切っても B300 に載るか。**
# 載るなら速度の利得をそのまま取れる（ホスト希望）。載らないなら既定を戻す。
# gc有効側(185GB)は実績値があるので、対比のために1本だけ取る。
_REAL_CONFIG = {
    "target_model": "minimax_h3",
    "resolution": 1024,
    "rank": 64,
    "batch": 2,
    "grad_accum": 2,
    "images": 24,
    "optimizer": "adamw",
    "lr": 0.00015,
    "lr_scheduler": "cosine",
    "network_kwargs": {"only_if_contains": ["transformer"]},
    "warmup_steps": 10,
    "measure_steps": 30,
    # 2026-09-20: compile を切って測る。知りたいのは VRAM であり、docs §5 に
    # 「VRAM は Inductor デフォルトでは変化なし」とあるので compile は交絡に
    # しかならない。実際 compile 有効で回したところ、実効バッチ4では学習の
    # 途中（step 6）で再コンパイルに入り8分以上戻ってこなかった
    # （compile_dynamic=True でも shape 変化を吸収しきれていない）。
    # ⚠️ この「実効バッチ>1 で途中再コンパイルが走る」こと自体が別途の課題。
    # 本番は compile 既定オンなので、実効バッチを上げるユーザーは同じ目に遭う。
    "compile": False,
}
PLANS["real_config"] = [
    {**_REAL_CONFIG, "tier": "b300", "gradient_checkpointing": True},
    {**_REAL_CONFIG, "tier": "b300", "gradient_checkpointing": False},
]

# チェックポイント保存のコスト検証。
#
# ホストの実案件（2000step / save_every 250 / 静止画145枚）は約4時間かかったが、
# 同条件の実測から逆算すると学習部分は26〜33分にしかならない。7倍の差が学習
# ループの外にある。最有力が「save_every 250 → 8回の保存」で、Modal Volume は
# NFS のため大きなファイルの書き込みが遅い。
#
# 40step を save_every=10（学習中に3回保存）で回し、save_every=40（学習中の
# 保存ゼロ）の real_config[gc OFF] と wall_s を比べれば1回あたりの保存コストが
# 出る。他の条件は完全に同じにしてあるので、差分がそのまま保存コスト。
PLANS["save_cost"] = [
    {**_REAL_CONFIG, "tier": "b300", "gradient_checkpointing": False, "save_every": 10},
]

# GUI モード既定条件での s/it 確定（2026-09-20）。
#
# LORA_SPI_BASELINE["minimax_h3"] = 0.90 は "3.60 s/it ÷ 実効バッチ4" という
# **正比例を仮定した逆算**であって、実効バッチ1での実測ではない（docs §14.14）。
# バッチ1の有効な実測は1件も無い（§14.1〜14.4 の 0.213 は tqdm パースのバグで
# 無効）。加えて §14.13/§14.14 はどちらも compile **無効**での計測だが、GUI
# モードは実効バッチ1固定なので **compile が有効**になる（§14.8 のガードは
# 実効バッチ>1 のときだけ compile を切る）。docs §5 では学習で compile は
# 約2倍効くため、GUI 既定の真値は 0.90 を大きく下回る可能性がある。
#
# real_config から変えるのは3点だけ（他は §14.13/§14.14 と揃えて比較可能に保つ）:
#   実効バッチ 4 -> 1 / compile 無効 -> 有効 / gc 無効（§14.14 と同じ）
# これで同時に決まるもの:
#   - LORA_SPI_BASELINE["minimax_h3"] の真値
#   - 実効バッチが所要秒に正比例するか（バッチ1実測 × 4 と §14.14 の 3.60 を比較）
#     → lora_batch_marginal_ratio の根拠。現行 0.65 は無効化された §14.7 由来。
#   - compile 有効時の s/it（未計測）
#
# warmup_steps は compile の初回コンパイルを確実に捨てるため real_config より厚い。
PLANS["gui_default"] = [
    {**_REAL_CONFIG, "tier": "b300", "gradient_checkpointing": False,
     "batch": 1, "grad_accum": 1, "compile": True,
     # 実写に近いバケットの割れ方を再現する（compile 有効なので shape 変化の
     # 影響が出る条件。正方形だけだと再コンパイル分を取り逃す）。
     "aspect_mix": True,
     "warmup_steps": 12, "measure_steps": 30},
]

# 本番プランへ行く前の1条件だけの通し確認。config 生成 → データセット →
# ai-toolkit 起動 → tqdm パース → VRAM 記録 までが実際の学習で通ることを、
# 最小の課金（$3前後）で確かめるためのもの。CLAUDE.md §0「まず最小条件で」。
PLANS["smoke"] = [
    {"tier": "b300", "target_model": "minimax_h3", "resolution": 1024, "images": 8,
     "warmup_steps": 10, "measure_steps": 30},
]

# 2026-09-21: LTX-2 の HF キャッシュから「読まれないファイル」158.94GB を削除した
# （docs/gpu-benchmarks.md §14.8.3）あとの検証用。ai-toolkit の LTX2Model が
# Diffusers サブフォルダ側だけを読むことはソースで確認済みだが、イメージに入って
# いる ai-toolkit の版が GitHub main とずれ得るので、実機で1本通して確定させる。
# 目的は「モデルがロードできて学習ステップが回るか」だけなので最小条件。
PLANS["ltx2_smoke"] = [
    {"tier": "b300", "target_model": "ltx_video", "resolution": 768, "images": 8,
     "warmup_steps": 5, "measure_steps": 15},
]

PLANS["default"] = (
    PLANS["tiers"]
    + [PLANS["resolution"][0], PLANS["resolution"][2]]  # 1024 は tiers 側で測る
    + PLANS["prep"]
    + PLANS["settings"][:1]  # gc=True 側（既定は False なので対比用に1本）
)


# 捨てるステップ数と測るステップ数。compile 有効時の最初の数十 step は
# 再コンパイル・キャッシュミスでばらつくので捨てる。
WARMUP_STEPS = 20
MEASURE_STEPS = 60

# 1条件あたりの壁時計上限（秒）。これを超えたら subprocess を kill して
# 「計測不能」として記録する。compile の cold warmup が ~599s（永続
# Inductor キャッシュありで ~325s）かかるので、それを見込んで広めに取る。
DEFAULT_MAX_SECONDS = 3600


# ---------------------------------------------------------------------------
# VRAM / GPU 使用率のサンプラ
# ---------------------------------------------------------------------------
class GpuSampler:
    """nvidia-smi を一定間隔で叩いて VRAM と使用率を記録する。

    CLAUDE.md §1 は「人が Modal ダッシュボードで見守る場面では自前実装は不要、
    必要なのは完了後にテキストログを遡って解析する運用」としている。このベンチは
    まさに後者（結果を JSONL に落として後で回帰にかける）なので自前で持つ。
    """

    def __init__(self, interval: float = 5.0):
        self.interval = interval
        self.samples: list[tuple[float, float, float]] = []  # (t, vram_gb, util%)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.error: str | None = None

    def _loop(self) -> None:
        t0 = time.time()
        while not self._stop.is_set():
            try:
                out = subprocess.run(
                    [
                        "nvidia-smi",
                        "--query-gpu=memory.used,utilization.gpu",
                        "--format=csv,noheader,nounits",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                # 複数GPUが見えても合計VRAM/最大utilでよい（本番も単一GPU前提）。
                vram_mb = 0.0
                util = 0.0
                for line in out.stdout.strip().splitlines():
                    parts = [p.strip() for p in line.split(",")]
                    if len(parts) >= 2:
                        vram_mb += float(parts[0])
                        util = max(util, float(parts[1]))
                self.samples.append((time.time() - t0, vram_mb / 1024.0, util))
            except Exception as exc:  # サンプリング失敗で計測本体を落とさない
                self.error = f"{type(exc).__name__}: {exc}"
            self._stop.wait(self.interval)

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=15)

    def summary(self) -> dict:
        if not self.samples:
            return {"vram_peak_gb": None, "vram_mean_gb": None, "util_mean": None, "samples": 0,
                    "sampler_error": self.error}
        vrams = [s[1] for s in self.samples]
        utils = [s[2] for s in self.samples]
        return {
            "vram_peak_gb": round(max(vrams), 2),
            "vram_mean_gb": round(sum(vrams) / len(vrams), 2),
            "util_mean": round(sum(utils) / len(utils), 1),
            "samples": len(self.samples),
            "sampler_error": self.error,
        }


# ---------------------------------------------------------------------------
# tqdm 進捗行のパーサ
# ---------------------------------------------------------------------------
# 例:  " 42%|####      | 84/200 [01:12<01:39,  1.17it/s, loss: 0.08]"
#      " 42%|####      | 84/200 [01:12<01:39,  5.03s/it]"
_TQDM_RE = re.compile(r"(\d+)\s*/\s*(\d+)\s*\[[^\]]*?,\s*([\d.]+)\s*(s/it|it/s)")
# latent キャッシュ中の tqdm は「Caching latents」等のラベルを伴う。
_CACHE_RE = re.compile(r"cach\w*\s+latent|caching", re.IGNORECASE)

# ⚠️ 学習ステップ行の判別子（2026-09-20 に追加。これが無くて実際に事故った）。
#
# ai-toolkit は学習以外にも tqdm を大量に出す — モデル重みのロード
# （`Loading weights: 12/398 [00:00<00:04, 86.26it/s]`）、latent キャッシュ、
# サンプル生成など。_TQDM_RE だけだとそれらも「学習ステップ」として拾ってしまい、
# flux2_klein_4b の計測では重みロードのバー(398項目)を総ステップ(50)到達と誤認して
# 15秒で kill し、別の条件では `s/it=0.005 / VRAM 0.0GB` という無意味な値を
# **ok=true** で返していた。
#
# 本番ワーカー（modal_lora_worker.py の _run_ai_toolkit_with_progress）は
# 同じ問題に対して「分母がtotal_stepsと一致」「lr: を含む」等の複合条件で
# 判別している。ここでも同じ厳しさにする: 分母が total_steps と一致し、かつ
# lr / loss を伴う行だけを学習ステップとみなす。
# 条件を満たす行が1つも無ければ spi は None になり ok=false で落ちる —
# 黙って嘘の数字を返すより、失敗として見えた方が良い。
#
# `loss` は単語境界を付けない: sd-scripts は `avr_loss=0.00101` と出すので
# `\bloss\b` だと直前の `_` が単語文字になりマッチしない。
_TRAIN_HINT_RE = re.compile(r"lr\s*:|loss", re.IGNORECASE)


def _trimmed_mean(xs: list[float], trim: float = 0.15) -> float | None:
    """上下 trim を落とした平均。本番の _trimmed_spi と同じ考え方。"""
    if len(xs) < 3:
        return None
    ys = sorted(xs)
    k = max(1, int(len(ys) * trim))
    core = ys[k:-k] if len(ys) > 2 * k else ys
    return sum(core) / len(core) if core else None


# ---------------------------------------------------------------------------
# データセット生成
# ---------------------------------------------------------------------------
# 実写データセットでよくあるアスペクト比。ai-toolkit は比率ごとにバケットを
# 作って別々の shape を流すため、正方形だけのデータでは **バケットが1つしか
# できない**。torch.compile 有効時は shape が変わるたびに再コンパイルが走り
# うる（docs §14.8 の「実効バッチ>1 で step 6 で8分停止」がまさにこれ）ので、
# 正方形だけで測ると実データより良い数字が出て、価格を原価割れ方向へ倒す。
_ASPECT_RATIOS: tuple[float, ...] = (1.0, 4 / 3, 3 / 4, 3 / 2, 2 / 3, 16 / 9, 9 / 16)


def _aspect_dims(long_edge: int, ratio: float) -> tuple[int, int]:
    """総画素数を long_edge^2 に保ったまま w:h = ratio にし、64 の倍数へ丸める。

    画素数を揃えるのが要点。長辺を固定して比率を振ると計算量まで一緒に動いて
    しまい、「バケットが割れた影響」と「単に重い/軽い画像になった影響」が
    分離できなくなる。
    """
    area = float(long_edge) * float(long_edge)
    w = int(round((area * ratio) ** 0.5 / 64.0)) * 64
    h = int(round((area / ratio) ** 0.5 / 64.0)) * 64
    return max(64, w), max(64, h)


def _make_dataset(
    n_images: int, long_edge: int, dest: str, aspect_mix: bool = False
) -> int:
    """計測用のダミーデータセットを作る。

    速度は画像の**中身**ではなく画素数と枚数で決まるので、合成画像で十分。
    実写を使わないことで、再現性（毎回同じ入力）と、権利まわりの面倒が
    同時に片付く。キャプションは固定文字列を添えて Qwen キャプショニングを
    確実にスキップさせる（キャプション生成時間が s/it に混ざらないように）。

    `aspect_mix=True` で `_ASPECT_RATIOS` を循環させ、実写データセットに近い
    バケットの割れ方を再現する。**既定は False**（従来どおり正方形のみ）で、
    過去に取った計測との比較可能性を壊さないため。
    """
    from PIL import Image
    import random

    d = pathlib.Path(dest)
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True, exist_ok=True)

    rnd = random.Random(1234)  # 固定 seed = 毎回同じデータセット
    for i in range(n_images):
        if aspect_mix:
            w, h = _aspect_dims(long_edge, _ASPECT_RATIOS[i % len(_ASPECT_RATIOS)])
        else:
            w = h = long_edge
        img = Image.new("RGB", (w, h))
        px = img.load()
        # 一様色だと VAE が潰れて非現実的に速くなる可能性があるので、
        # 粗いランダムブロックでそれなりの高周波成分を持たせる。
        block = 32
        for by in range(0, h, block):
            for bx in range(0, w, block):
                c = (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256))
                for y in range(by, min(by + block, h)):
                    for x in range(bx, min(bx + block, w)):
                        px[x, y] = c
        img.save(d / f"{i:04d}.png")
        (d / f"{i:04d}.txt").write_text("ullbench a photo of sks subject", encoding="utf-8")
    return n_images


# ---------------------------------------------------------------------------
# 計測本体（GPU 上で動く）
# ---------------------------------------------------------------------------
def _spi_from_samples(
    step_samples: list[tuple[float, int]], warmup_steps: int
) -> tuple[float | None, list[float]]:
    """(読み取り時刻, step番号) の列から steady-state の s/it を出す。

    ⚠️ 2026-09-20 — ここには **測定値を丸ごと無意味にするバグ**があった。
    ai-toolkit は1ステップにつき tqdm 行を2本出す:

        4/2000 [00:46<...]   ← step 4 完了
        4/2000 [00:51<...]   ← step 4 の行を loss 更新で再描画
        5/2000 [00:51<...]   ← step 5

    旧実装は「step が増えた隣接ペア」だけを採っていたが、それは
    `(00:51, 4) -> (00:51, 5)` ＝ **同一時刻の2行**であり、本当の所要時間
    （00:46 -> 00:51）は ds == 0 のペアに入って捨てられていた。測れていたのは
    「ログ2行をパイプから読んで print する時間」で、それが 0.2〜0.7 という
    値の正体。同条件の本番実測は 5.24 s/it で、**約8倍の過小評価**だった。

    正しくは **各 step 番号の最初の出現だけ**を残してから差分を取る。実際の
    本番ログで検算すると 5.33 s/it となり、tqdm 自身の表示とも一致する。
    """
    first_seen: dict[int, float] = {}
    for ts, st in step_samples:
        if st not in first_seen:
            first_seen[st] = ts
    steps = sorted(st for st in first_seen if st > warmup_steps)
    intervals: list[float] = []
    for s0, s1 in zip(steps, steps[1:]):
        ds = s1 - s0
        if ds > 0:
            intervals.append((first_seen[s1] - first_seen[s0]) / ds)
    return _trimmed_mean(intervals), intervals


def _run_benchmark(spec: dict) -> dict:
    """1条件を計測して結果 dict を返す。GPU 関数から呼ばれる。"""
    started_at = time.time()
    tier = spec["tier"]
    target_model = spec["target_model"]
    resolution = int(spec.get("resolution", 1024))
    n_images = int(spec.get("images", DEFAULT_IMAGES))
    rank = int(spec.get("rank", 32))
    batch = int(spec.get("batch", 1))
    grad_accum = int(spec.get("grad_accum", 1))
    optimizer = str(spec.get("optimizer", DEFAULT_TRAIN_SETTINGS["optimizer"]))
    grad_ckpt = bool(
        spec.get("gradient_checkpointing", DEFAULT_TRAIN_SETTINGS["gradient_checkpointing"])
    )
    aspect_mix = bool(spec.get("aspect_mix", False))
    warmup_steps = int(spec.get("warmup_steps", WARMUP_STEPS))
    measure_steps = int(spec.get("measure_steps", MEASURE_STEPS))
    max_seconds = int(spec.get("max_seconds", DEFAULT_MAX_SECONDS))
    total_steps = warmup_steps + measure_steps

    result: dict = {
        "schema": 1,
        "tier": tier,
        "gpu_request": TIER_GPU.get(tier, tier),
        "target_model": target_model,
        "arch": W._arch_for_target(target_model),
        "resolution": resolution,
        "images": n_images,
        "rank": rank,
        "batch": batch,
        "grad_accum": grad_accum,
        "effective_batch": batch * grad_accum,
        "optimizer": optimizer,
        "gradient_checkpointing": grad_ckpt,
        "compile": spec.get("compile"),
        "aspect_mix": aspect_mix,
        "save_every": int(spec.get("save_every") or total_steps),
        "total_steps": total_steps,
        "warmup_steps": warmup_steps,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ok": False,
    }

    sampler = GpuSampler()
    sampler.start()
    proc = None
    try:
        lora_name = f"ullbench_{tier}_{target_model}_{resolution}_{n_images}"
        _make_dataset(n_images, resolution, W.DATASET_DIR, aspect_mix=aspect_mix)
        result["dataset_ready_s"] = round(time.time() - started_at, 1)

        # 本番と同じ config 生成を通す（公平性のため独自に YAML を書かない）。
        config_path = W._build_config(
            lora_name=lora_name,
            trigger="ullbench",
            target_model=target_model,
            tc={
                "rank": rank,
                "alpha": rank // 2,
                "steps": total_steps,
                "optimizer": optimizer,
                # _build_config は tc["compile"] の明示指定を最優先する
                # （環境変数はコンテナ側で再評価されるため CLI から効かない）。
                # None なら本番既定（LORA_COMPILE_ENABLED）に従う。
                **({} if spec.get("compile") is None else {"compile": bool(spec["compile"])}),
                # 途中サンプル生成は shape が変わるたび再コンパイルが走り
                # （~220s）、s/it の測定を壊す。ベンチでは完全に切る。
                "sample_every": 0,
                # 既定は最後に1回だけ（= 学習中の保存コストをゼロにする）。
                # spec で小さい値を渡すと学習中に保存が入り、その分が wall_s と
                # step 間隔に現れる —「save_every を細かくすると遅くなる」の
                # 検証用（CLAUDE.md §3 は save_every: 500 を標準としている）。
                "save_every": int(spec.get("save_every") or total_steps),
            },
            override=None,
            resolution=resolution,
        )
        # batch / gradient_checkpointing は tc では変えられないので直接上書き。
        # ついでに量子化・オフロードが効いていないことを検証する。
        result["resolved_config"] = _patch_config(
            config_path,
            gradient_checkpointing=grad_ckpt,
            batch=batch,
            optimizer=optimizer,
            grad_accum=grad_accum,
            network_kwargs=spec.get("network_kwargs"),
            lr=spec.get("lr"),
            lr_scheduler=spec.get("lr_scheduler"),
        )
        result["config_path"] = str(config_path)

        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"

        launch_ts = time.time()
        # CLAUDE.md §1: subprocess の標準出力は溜め込まず1行ずつ流す。
        proc = subprocess.Popen(
            ["python", "-u", "run.py", str(config_path)],
            cwd=W.AI_TOOLKIT_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )

        step_samples: list[tuple[float, int]] = []
        units_seen: set[str] = set()
        first_train_ts: float | None = None
        cache_first_ts: float | None = None
        cache_last_ts: float | None = None
        tail: list[str] = []
        timed_out = False

        for raw in proc.stdout:  # type: ignore[union-attr]
            line = raw.rstrip("\n")
            now = time.time()
            print(line, flush=True)  # Modal のログにそのまま流す
            tail.append(line)
            if len(tail) > 80:
                tail.pop(0)

            if now - launch_ts > max_seconds:
                timed_out = True
                break

            if _CACHE_RE.search(line):
                if cache_first_ts is None:
                    cache_first_ts = now
                cache_last_ts = now
                continue

            m = _TQDM_RE.search(line)
            if not m:
                continue
            # 学習ステップ行だけを採る（上の _TRAIN_HINT_RE のコメント参照）。
            if int(m.group(2)) != total_steps or not _TRAIN_HINT_RE.search(line):
                continue
            step = int(m.group(1))
            rate = float(m.group(3))
            unit = m.group(4)
            units_seen.add(unit)
            # ここが docs §5 とのズレの元。生の単位を必ず残す。
            s_per_it = rate if unit == "s/it" else (1.0 / rate if rate else 0.0)
            if first_train_ts is None:
                first_train_ts = now
                result["warmup_s"] = round(now - launch_ts, 1)
            step_samples.append((now, step))
            if step >= total_steps:
                break
            # s/it 単体の値も残す（tqdm の移動平均なので参考値）
            result.setdefault("_last_reported_spi", s_per_it)

        if timed_out:
            result["error"] = f"max_seconds({max_seconds}s) を超過したため中断"
        _kill(proc)

        # 壁時計の差分から s/it を出す。ロジックは _spi_from_samples()
        # （回帰テスト付き — _parser_selftest を参照）。
        spi, intervals = _spi_from_samples(step_samples, warmup_steps)

        result.update(
            {
                "tqdm_unit": sorted(units_seen) or None,
                "spi_steady": round(spi, 4) if spi else None,
                "spi_samples": len(intervals),
                "spi_reported_last": result.pop("_last_reported_spi", None),
                "steps_observed": step_samples[-1][1] if step_samples else 0,
                "cache_s": (
                    round(cache_last_ts - cache_first_ts, 1)
                    if cache_first_ts and cache_last_ts
                    else None
                ),
                "wall_s": round(time.time() - launch_ts, 1),
                "returncode": proc.returncode,
            }
        )

        # 健全性チェック。「s/it が出た」だけを成功条件にしていたため、重みロードの
        # 進捗バーを拾って `s/it=0.005 / VRAM 0.0GB` を ok=true で返す事故があった
        # （2026-09-20）。値付けの根拠になる数字なので、明らかにおかしい結果は
        # 成功として通さない。
        sanity: list[str] = []
        if timed_out:
            sanity.append(f"max_seconds({max_seconds}s) 超過")
        if not spi:
            sanity.append("定常 s/it を算出できなかった")
        elif not (0.001 <= spi <= 120):
            sanity.append(f"s/it={spi:.4f} が現実的な範囲(0.001〜120)の外")
        if len(intervals) < 5:
            sanity.append(f"学習ステップのサンプルが {len(intervals)} 点しかない")
        observed = step_samples[-1][1] if step_samples else 0
        if observed < total_steps * 0.8:
            sanity.append(f"到達ステップ {observed} が宣言値 {total_steps} に届いていない")
        peak = sampler.samples and max(s[1] for s in sampler.samples) or 0
        if peak <= 0.5:
            sanity.append(f"peak VRAM {peak:.2f}GB — GPU で学習していない疑い")

        result["ok"] = not sanity
        if sanity:
            result["error"] = " / ".join(sanity)

        # チェックポイント保存のコスト検証用。
        # (a) 実際に書かれた .safetensors のサイズ（Modal Volume は NFS で
        #     書き込みが遅く、CLAUDE.md §1 が「4MiB単位でバッファしないと
        #     実効数KB/秒まで落ちる」と警告している経路）
        # (b) step 間隔の生データ。保存が挟まった step だけ突出するので、
        #     trimmed mean では消えてしまう「1回あたりの保存コスト」が見える。
        try:
            out_dir = pathlib.Path(W.OUTPUT_DIR)
            files = sorted(out_dir.rglob("*.safetensors"))
            result["saved_files"] = [
                {"name": p.name, "mb": round(p.stat().st_size / 1e6, 1)} for p in files[:20]
            ]
            result["saved_count"] = len(files)
        except Exception as exc:
            result["saved_files"] = f"{type(exc).__name__}: {exc}"
        if intervals:
            top = sorted(intervals, reverse=True)[:5]
            result["slowest_step_intervals_s"] = [round(x, 2) for x in top]
            result["median_step_interval_s"] = round(sorted(intervals)[len(intervals) // 2], 4)
        if not result["ok"]:
            result["tail"] = tail[-40:]

    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        _kill(proc)
    finally:
        sampler.stop()
        result.update(sampler.summary())
        result["total_s"] = round(time.time() - started_at, 1)

    usd_h = TIER_USD_PER_HOUR.get(tier)
    if usd_h:
        result["run_cost_usd"] = round(usd_h * result["total_s"] / 3600.0, 3)

    print("[bench_result] " + json.dumps(result, ensure_ascii=False), flush=True)
    return result


def _patch_config(
    config_path,
    *,
    gradient_checkpointing: bool,
    batch: int,
    optimizer: str,
    grad_accum: int = 1,
    network_kwargs: dict | None = None,
    lr: float | None = None,
    lr_scheduler: str | None = None,
) -> dict:
    """本番の `_build_config` が書いた YAML を、計測条件に合わせて上書きする。

    `_build_config` は `train.batch_size` / `gradient_accumulation_steps` を
    1 にハードコードし、`gradient_checkpointing` も True 固定なので、`tc` 経由
    では変えられない（modal_lora_worker.py:1828-1833）。ベンチでは条件を振る
    必要があるのでここで直接書き換える。

    同時に「VRAM をケチらない」前提が本当に効いているか（quantize / low_vram が
    False か）を検証し、違っていたら例外を投げる — 気づかないまま量子化した
    状態で計測してしまうのが一番まずい（CLAUDE.md §1）。
    """
    import yaml

    p = pathlib.Path(config_path)
    cfg = yaml.safe_load(p.read_text(encoding="utf-8"))
    proc_block = cfg["config"]["process"][0]

    train = proc_block.setdefault("train", {})
    train["gradient_checkpointing"] = bool(gradient_checkpointing)
    train["batch_size"] = int(batch)
    train["gradient_accumulation_steps"] = int(grad_accum)
    train["optimizer"] = optimizer
    if lr is not None:
        train["lr"] = lr
    if lr_scheduler:
        train["lr_scheduler"] = lr_scheduler

    # network_kwargs（例: only_if_contains: ["transformer"]）は LoRA を挿す
    # モジュールを絞るので、VRAM と s/it の両方に効く。本番の実設定を再現する
    # には必須。
    if network_kwargs:
        proc_block.setdefault("network", {})["network_kwargs"] = network_kwargs

    model_block = proc_block.get("model", {})
    for key in ("quantize", "low_vram"):
        if model_block.get(key):
            raise RuntimeError(
                f"model.{key} が True になっている。量子化/オフロードした状態の "
                f"s/it は値付けの根拠にできない（CLAUDE.md §1）。"
            )

    p.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return {
        "train": {
            k: train.get(k)
            for k in ("optimizer", "lr", "dtype", "batch_size",
                      "gradient_accumulation_steps", "gradient_checkpointing")
        },
        "model": {k: model_block.get(k) for k in ("arch", "quantize", "low_vram")},
        "network": proc_block.get("network"),
        "datasets_resolution": (proc_block.get("datasets") or [{}])[0].get("resolution"),
    }


def _kill(proc, grace: float = 20.0) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=10)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# CPU プローブ（GPU を1秒も使わずに配管を検証する）
# ---------------------------------------------------------------------------
@app.function(
    image=BENCH_IMAGE,
    volumes={W.MODELS_DIR: W.vol},
    timeout=30 * 60,
    scaledown_window=2,
    secrets=SECRETS,
)
def cpu_probe() -> dict:
    """GPU なしで、計測に必要な配管が全部通ることを確認する。

    CLAUDE.md §1:「CPU で import と資産準備がグリーン → はじめて GPU 実行」。
    ここが赤いまま GPU を叩くと crash-loop で課金が垂れ流しになる。
    """
    out: dict = {"ok": False, "checks": {}}

    out["checks"]["import_worker"] = bool(W.TARGET_MODELS)
    out["checks"]["ai_toolkit_dir"] = pathlib.Path(W.AI_TOOLKIT_DIR, "run.py").exists()

    # データセット生成（小さく）
    n = _make_dataset(4, 512, "/root/_probe_dataset")
    out["checks"]["dataset"] = n == 4

    # 本番の config 生成が計測条件で通るか（全 arch 分）
    cfg_ok = {}
    for tm in ("minimax_h3", "qwen_image"):
        try:
            p = W._build_config(
                lora_name=f"probe_{tm}",
                trigger="ullbench",
                target_model=tm,
                tc={"rank": 32, "alpha": 16, "steps": 10, "batch_size": 1,
                    "sample_every": 0, "save_every": 10},
                override=None,
                resolution=1024,
            )
            cfg_ok[tm] = pathlib.Path(p).exists()
        except Exception as exc:
            cfg_ok[tm] = f"{type(exc).__name__}: {exc}"
    out["checks"]["build_config"] = cfg_ok

    # ベース重みが Volume にあるか（GPU は絶対にダウンロードしない方針）。
    # 画像系 arch の tier 実測に進むため、対象を全プリセットへ広げた。
    missing = {}
    for tm in (
        "minimax_h3", "qwen_image", "flux2_klein_4b", "zimage", "anima", "krea2",
        "wan22_14b", "ltx_video",
    ):
        try:
            missing[tm] = W._missing_base_artifacts(tm)
        except Exception as exc:
            missing[tm] = f"確認不可: {type(exc).__name__}: {exc}"
    out["checks"]["base_weights_missing"] = missing

    # パーサの自己テスト（GPU 不要。単位の取り違えを検出する回帰テスト）
    out["checks"]["parser"] = _parser_selftest()

    # サンプル生成を止めるための設定キーが、この ai-toolkit リビジョンに
    # 実在するかをソースで確認する（CLAUDE.md §0: 読めるソースは実測より先に
    # 読む）。存在しないキーを本番 config に入れると全 LoRA ジョブが落ちる。
    out["checks"]["sampling_opts"] = _probe_sampling_options()

    # 多概念 LoRA（概念ごとに学習量を変える）を ai-toolkit で出せるかの調査。
    out["checks"]["dataset_opts"] = _probe_dataset_options()

    out["ok"] = (
        out["checks"]["ai_toolkit_dir"]
        and out["checks"]["dataset"]
        and all(v is True for v in cfg_ok.values())
        and out["checks"]["parser"]["ok"]
    )
    print("[cpu_probe] " + json.dumps(out, ensure_ascii=False, indent=2), flush=True)
    return out


def _probe_sampling_options() -> dict:
    """ai-toolkit の TrainConfig / SampleConfig に、サンプル生成を止めるための
    フィールドが実在するかを調べる。

    候補: train.disable_sampling / train.skip_first_sample / sample.sample_every。
    実在が確認できたものだけを本番 config で使う。
    """
    out: dict = {}
    try:
        import importlib

        mod = importlib.import_module("toolkit.config_modules")
        for cls_name in ("TrainConfig", "SampleConfig"):
            cls = getattr(mod, cls_name, None)
            if cls is None:
                out[cls_name] = "クラスが見つからない"
                continue
            try:
                inst = cls()
                fields = sorted(k for k in vars(inst) if not k.startswith("_"))
            except Exception:
                fields = sorted(
                    k for k in vars(cls) if not k.startswith("_") and not callable(getattr(cls, k))
                )
            out[cls_name] = fields
    except Exception as exc:
        out["error"] = f"{type(exc).__name__}: {exc}"

    # ソース文字列でも裏を取る（__init__ が kwargs を dict から読む実装だと
    # vars() に出ないことがあるため）。
    hits: dict = {}
    try:
        src_path = pathlib.Path(W.AI_TOOLKIT_DIR) / "toolkit" / "config_modules.py"
        src = src_path.read_text(encoding="utf-8", errors="replace")
        for key in ("disable_sampling", "skip_first_sample", "sample_every", "samples"):
            hits[key] = src.count(key)
        out["config_modules_py"] = hits
    except Exception as exc:
        out["config_modules_py"] = f"{type(exc).__name__}: {exc}"
    return out


def _probe_dataset_options() -> dict:
    """ai-toolkit が「複数データセット × サブセットごとの繰り返し回数」に
    対応しているかを、ソースを読んで確認する。

    sd-scripts は `[[datasets.subsets]]` + `num_repeats` で概念ごとに学習量を
    変えられる（多概念 LoRA の定番手法）。ai-toolkit 側に同等の口があるかで、
    この機能を全 arch で出せるか SDXL 限定になるかが決まる。
    """
    out: dict = {}
    src_dir = pathlib.Path(W.AI_TOOLKIT_DIR)

    # 1) DatasetConfig のフィールド一覧（設定ファイルから何を受けるか）
    cfg = src_dir / "toolkit" / "config_modules.py"
    try:
        text = cfg.read_text(encoding="utf-8", errors="replace")
        i = text.find("class DatasetConfig")
        if i < 0:
            out["DatasetConfig"] = "クラスが見つからない"
        else:
            # 次の class 定義までを切り出して self.<field> = を拾う
            j = text.find("\nclass ", i + 1)
            body = text[i : j if j > 0 else len(text)]
            fields = sorted(set(re.findall(r"self\.([a-z0-9_]+)\s*[:=]", body)))
            out["DatasetConfig"] = fields
            out["DatasetConfig_lines"] = body.count("\n")
    except Exception as exc:
        out["DatasetConfig"] = f"{type(exc).__name__}: {exc}"

    # 2) 繰り返し回数に相当するキーワードの出現箇所（リポジトリ全体）
    hits: dict[str, list[str]] = {}
    for kw in ("num_repeats", "repeats", "subsets", "num_frames"):
        found: list[str] = []
        try:
            for p in src_dir.rglob("*.py"):
                if ".git" in p.parts:
                    continue
                try:
                    t = p.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    continue
                if kw in t:
                    found.append(f"{p.relative_to(src_dir)}:{t.count(kw)}")
                if len(found) >= 8:
                    break
        except Exception as exc:
            found.append(f"走査失敗: {type(exc).__name__}: {exc}")
        hits[kw] = found
    out["keyword_hits"] = hits
    return out


def _parser_selftest() -> dict:
    """tqdm の "s/it" と "it/s" を両方とも正しく秒/itへ正規化できるか。

    docs/gpu-benchmarks.md §5 の 25 倍のズレはこの取り違えが原因とみている
    ので、ここだけは明示的に回帰テストを置いておく。
    """
    cases = [
        (" 42%|####      | 84/200 [01:12<01:39,  5.03s/it]", 5.03),
        (" 42%|####      | 84/200 [01:12<01:39,  5.03it/s]", 1.0 / 5.03),
        (" 10%|#         | 20/200 [00:05<00:50,  2.60it/s, loss: 0.08]", 1.0 / 2.60),
    ]
    results = []
    ok = True
    for text, expected in cases:
        m = _TQDM_RE.search(text)
        if not m:
            ok = False
            results.append({"line": text, "matched": False})
            continue
        rate = float(m.group(3))
        unit = m.group(4)
        spi = rate if unit == "s/it" else 1.0 / rate
        good = abs(spi - expected) < 1e-6
        ok = ok and good
        results.append({"unit": unit, "spi": round(spi, 4), "ok": good})

    # 2026-09-20 追加: 1ステップ2行の重複を畳めているかの回帰テスト。
    # 旧実装はここで 0.0 を返していた（詳細は _spi_from_samples の docstring）。
    # 本番ログ（yukipas_v6, 5.2〜5.3 s/it）の並びをそのまま使う。
    dup_samples = [
        (22.0, 1), (35.0, 1), (35.0, 2), (41.0, 2), (41.0, 3), (46.0, 3),
        (46.0, 4), (51.0, 4), (51.0, 5), (57.0, 5), (57.0, 6), (62.0, 6),
        (62.0, 7), (67.0, 7), (67.0, 8), (72.0, 8), (72.0, 9), (77.0, 9),
        (77.0, 10), (83.0, 10), (83.0, 11),
    ]
    dup_spi, dup_intervals = _spi_from_samples(dup_samples, warmup_steps=4)
    dup_ok = dup_spi is not None and 4.5 < dup_spi < 6.0
    ok = ok and dup_ok
    results.append({
        "case": "duplicate tqdm lines per step",
        "spi": round(dup_spi, 4) if dup_spi else None,
        "intervals": dup_intervals,
        "expected": "4.5〜6.0（旧実装は 0.0 を返していた）",
        "ok": dup_ok,
    })
    return {"ok": ok, "cases": results}


# ---------------------------------------------------------------------------
# ハーネス確認（最安 tier）
# ---------------------------------------------------------------------------
@app.function(
    image=BENCH_IMAGE,
    volumes={W.MODELS_DIR: W.vol},
    timeout=30 * 60,
    scaledown_window=2,
)
def volume_write_probe(size_mb: int = 1200) -> dict:
    """Modal Volume への書き込み速度を CPU だけで測る。

    背景: ホストの実案件（2000step / save_every 250）は約4時間かかったが、
    同条件の実測では学習部分が26〜33分にしかならない。差の容疑者が
    「1.2GB の中間チェックポイント × 8回」の Volume 書き込み。
    GPU で学習を回して測るのは遠回りなので、書き込みだけを切り出す。

    CLAUDE.md §1 は「Modal Volume (NFS) は1回あたりの読み書きオーバーヘッドが
    大きい。小さいチャンクを大量に読み書きすると実効速度が数KB/秒まで落ち込む。
    読み書きとも4MiB単位でバッファすること」と明記している。その主張自体も
    ここで検証する（バッファ有無で比較）。
    """
    import os
    import time

    results: dict = {"size_mb": size_mb}
    payload = os.urandom(8 * 1024 * 1024)  # 8MiB の元データを使い回す
    target_bytes = size_mb * 1024 * 1024
    probe_dir = pathlib.Path(W.MODELS_DIR) / "_bench_write_probe"
    probe_dir.mkdir(parents=True, exist_ok=True)

    # buffering: -1 = Python 既定(約8KiB)、4MiB = CLAUDE.md 推奨
    for label, buf in (("default_buffer", -1), ("4MiB_buffer", 4 * 1024 * 1024)):
        p = probe_dir / f"probe_{label}.bin"
        try:
            t0 = time.time()
            written = 0
            with open(p, "wb", buffering=buf) as fh:
                while written < target_bytes:
                    n = min(len(payload), target_bytes - written)
                    fh.write(payload[:n])
                    written += n
                fh.flush()
                os.fsync(fh.fileno())
            write_s = time.time() - t0

            # Volume は commit しないと永続化されない。commit も実コストなので測る。
            t1 = time.time()
            W.vol.commit()
            commit_s = time.time() - t1

            results[label] = {
                "write_s": round(write_s, 1),
                "commit_s": round(commit_s, 1),
                "total_s": round(write_s + commit_s, 1),
                "mb_per_s": round(size_mb / max(write_s + commit_s, 0.001), 1),
            }
        except Exception as exc:
            results[label] = f"{type(exc).__name__}: {exc}"
        finally:
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass

    try:
        W.vol.commit()
        probe_dir.rmdir()
    except Exception:
        pass

    # 実案件（1.2GB × 8回）に換算
    best = results.get("4MiB_buffer")
    if isinstance(best, dict):
        results["projection_8_saves_min"] = round(best["total_s"] * 8 / 60, 1)
    print("[volume_write_probe] " + json.dumps(results, ensure_ascii=False), flush=True)
    return results


@app.function(image=BENCH_IMAGE, gpu=TIER_GPU["t4"], timeout=15 * 60, scaledown_window=2)
def harness_check() -> dict:
    """T4 で「VRAM サンプラが実機で動くか」だけを確かめる。学習はしない。

    CLAUDE.md §1:「監視ロジック自体の動作確認は最安 GPU tier（T4等）で先に行う」。
    本番モデルは T4 に載らないので、ここで測るのは監視系だけ。
    """
    sampler = GpuSampler(interval=2.0)
    sampler.start()
    try:
        import torch

        info = {
            "cuda": torch.cuda.is_available(),
            "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        }
        # VRAM が動くところを作る（サンプラが 0 以外を拾えることの確認）
        if torch.cuda.is_available():
            buf = torch.zeros(256 * 1024 * 1024, dtype=torch.uint8, device="cuda")
            time.sleep(8)
            del buf
            torch.cuda.empty_cache()
        time.sleep(4)
    finally:
        sampler.stop()
    out = {"ok": False, **info, **sampler.summary(), "parser": _parser_selftest()}
    out["ok"] = bool(out.get("samples")) and out["parser"]["ok"] and bool(out.get("cuda"))
    print("[harness_check] " + json.dumps(out, ensure_ascii=False, indent=2), flush=True)
    return out


# ---------------------------------------------------------------------------
# tier ごとの計測関数（Modal は gpu= をデコレート時に固定するので tier 分作る）
# ---------------------------------------------------------------------------
# Modal は `@app.function` をグローバルスコープの関数にしか適用できない
# （ループやファクトリ内で作るとデコレート時に InvalidError）。gpu= も
# デコレート時に固定なので、tier ごとに素直に書き下す。中身はすべて
# `_run_benchmark` に委譲しているので、実際のロジックは1箇所だけ。
_BENCH_KW = dict(
    image=BENCH_IMAGE,
    volumes={W.MODELS_DIR: W.vol},
    # 1条件あたりの Modal 側ハード上限。DEFAULT_MAX_SECONDS 側で先に自力で
    # 止まる想定で、これは最後の保険（CLAUDE.md §0「タイムアウトは多めに」）。
    timeout=2 * 60 * 60,
    scaledown_window=2,
    secrets=SECRETS,
)


@app.function(gpu=TIER_GPU["b300"], **_BENCH_KW)
def bench_b300(spec: dict) -> dict:
    return _run_benchmark({**spec, "tier": "b300"})


@app.function(gpu=TIER_GPU["b200"], **_BENCH_KW)
def bench_b200(spec: dict) -> dict:
    return _run_benchmark({**spec, "tier": "b200"})


@app.function(gpu=TIER_GPU["h200"], **_BENCH_KW)
def bench_h200(spec: dict) -> dict:
    return _run_benchmark({**spec, "tier": "h200"})


@app.function(gpu=TIER_GPU["rtx_pro_6000"], **_BENCH_KW)
def bench_rtx_pro_6000(spec: dict) -> dict:
    return _run_benchmark({**spec, "tier": "rtx_pro_6000"})


@app.function(gpu=TIER_GPU["l40s"], **_BENCH_KW)
def bench_l40s(spec: dict) -> dict:
    return _run_benchmark({**spec, "tier": "l40s"})

BENCH_BY_TIER = {
    "b300": bench_b300,
    "b200": bench_b200,
    "h200": bench_h200,
    "rtx_pro_6000": bench_rtx_pro_6000,
    "l40s": bench_l40s,
}


# ---------------------------------------------------------------------------
# ドライバ（ローカル）
# ---------------------------------------------------------------------------
def _estimate_seconds(spec: dict) -> float:
    """概算の所要秒。コスト表示用のラフな見積もりで、精度は要らない。"""
    arch = W._arch_for_target(spec["target_model"])
    spi = W.LORA_SPI_BASELINE.get(arch, W.LORA_SPI_BASELINE_DEFAULT)
    res_factor = (int(spec.get("resolution", 1024)) / 1024.0) ** 2
    steps = spec.get("warmup_steps", WARMUP_STEPS) + spec.get("measure_steps", MEASURE_STEPS)
    # モデルロード + latent キャッシュ + compile warmup の概算
    overhead = 300 + 20 * int(spec.get("images", DEFAULT_IMAGES)) + 400
    return overhead + steps * spi * res_factor


@app.local_entrypoint()
def main(plan: str = "default", confirm: bool = False, out_dir: str = "bench_results"):
    """計測を実行する。--confirm を付けるまでは何も起動しない。

    メモリ [[gpu-experiment-cost-discipline]]: 実機テストは実行直前に必ず
    承認を取る。既定をドライランにしてあるのはそのため。
    """
    specs = PLANS.get(plan)
    if not specs:
        raise SystemExit(f"未知の plan: {plan}（選べるのは {', '.join(PLANS)}）")

    total_usd = 0.0
    print(f"\n=== 実行計画: {plan}（{len(specs)} 条件）===")
    for i, s in enumerate(specs, 1):
        est = _estimate_seconds(s)
        usd = TIER_USD_PER_HOUR[s["tier"]] * est / 3600.0
        total_usd += usd
        gc = s.get("gradient_checkpointing", DEFAULT_TRAIN_SETTINGS["gradient_checkpointing"])
        print(
            f"{i:2d}. {s['tier']:<14} {s['target_model']:<12} "
            f"{s.get('resolution', 1024)}px 画像{s.get('images', DEFAULT_IMAGES)}枚 "
            f"opt={s.get('optimizer', DEFAULT_TRAIN_SETTINGS['optimizer'])} "
            f"grad_ckpt={'ON' if gc else 'OFF'} "
            f"→ 概算 {est/60:.0f}分 / ${usd:.2f}"
        )
    print(f"--- 概算合計: ${total_usd:.2f}（約¥{total_usd*150:,.0f}）---")
    print("※ compile の cold warmup を含む粗い見積もり。実測とはずれる。")

    if not confirm:
        print("\nドライランです。実行するには --confirm を付けてください。")
        return

    out_path = pathlib.Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    jsonl = out_path / f"lora_stage1_{time.strftime('%Y%m%d_%H%M%S')}.jsonl"
    print(f"\n結果の追記先: {jsonl}\n")

    # 逐次実行。並列にすると同時に複数の GPU を掴んで事故ったときの被害が
    # 大きいのと、Volume 上の Inductor キャッシュを前の条件から使い回せる。
    for i, s in enumerate(specs, 1):
        print(f"\n===== [{i}/{len(specs)}] {s} =====", flush=True)
        fn = BENCH_BY_TIER.get(s["tier"])
        if fn is None:
            print(f"  skip: 未対応の tier {s['tier']}")
            continue
        try:
            res = fn.remote(s)
        except Exception as exc:
            res = {**s, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        with jsonl.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(res, ensure_ascii=False) + "\n")
        status = "OK " if res.get("ok") else "NG "
        print(
            f"  {status} s/it={res.get('spi_steady')} "
            f"unit={res.get('tqdm_unit')} "
            f"VRAM peak={res.get('vram_peak_gb')}GB "
            f"warmup={res.get('warmup_s')}s cache={res.get('cache_s')}s "
            f"cost=${res.get('run_cost_usd')}"
        )
        if not res.get("ok"):
            print(f"  error: {res.get('error')}")

    print(f"\n完了。結果: {jsonl}")
    print("次: この JSONL から s/it の tier 係数・解像度指数・prep の回帰を出し、")
    print("    LORA_SPI_BASELINE と lora_* knob へ反映する。")
