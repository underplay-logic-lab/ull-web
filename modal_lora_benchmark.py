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
    "t4": 0.59,
}

# Modal の gpu= に渡す文字列。
TIER_GPU = {
    "b300": "b300",
    "b200": "b200",
    "h200": "h200",
    "rtx_pro_6000": "rtx-pro-6000",
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
# 本番プランへ行く前の1条件だけの通し確認。config 生成 → データセット →
# ai-toolkit 起動 → tqdm パース → VRAM 記録 までが実際の学習で通ることを、
# 最小の課金（$3前後）で確かめるためのもの。CLAUDE.md §0「まず最小条件で」。
PLANS["smoke"] = [
    {"tier": "b300", "target_model": "minimax_h3", "resolution": 1024, "images": 8,
     "warmup_steps": 10, "measure_steps": 30},
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
def _make_dataset(n_images: int, long_edge: int, dest: str) -> int:
    """計測用のダミーデータセットを作る。

    速度は画像の**中身**ではなく画素数と枚数で決まるので、合成画像で十分。
    実写を使わないことで、再現性（毎回同じ入力）と、権利まわりの面倒が
    同時に片付く。キャプションは固定文字列を添えて Qwen キャプショニングを
    確実にスキップさせる（キャプション生成時間が s/it に混ざらないように）。
    """
    from PIL import Image
    import random

    d = pathlib.Path(dest)
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True, exist_ok=True)

    rnd = random.Random(1234)  # 固定 seed = 毎回同じデータセット
    for i in range(n_images):
        img = Image.new("RGB", (long_edge, long_edge))
        px = img.load()
        # 一様色だと VAE が潰れて非現実的に速くなる可能性があるので、
        # 粗いランダムブロックでそれなりの高周波成分を持たせる。
        block = 32
        for by in range(0, long_edge, block):
            for bx in range(0, long_edge, block):
                c = (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256))
                for y in range(by, min(by + block, long_edge)):
                    for x in range(bx, min(bx + block, long_edge)):
                        px[x, y] = c
        img.save(d / f"{i:04d}.png")
        (d / f"{i:04d}.txt").write_text("ullbench a photo of sks subject", encoding="utf-8")
    return n_images


# ---------------------------------------------------------------------------
# 計測本体（GPU 上で動く）
# ---------------------------------------------------------------------------
def _run_benchmark(spec: dict) -> dict:
    """1条件を計測して結果 dict を返す。GPU 関数から呼ばれる。"""
    started_at = time.time()
    tier = spec["tier"]
    target_model = spec["target_model"]
    resolution = int(spec.get("resolution", 1024))
    n_images = int(spec.get("images", DEFAULT_IMAGES))
    rank = int(spec.get("rank", 32))
    batch = int(spec.get("batch", 1))
    optimizer = str(spec.get("optimizer", DEFAULT_TRAIN_SETTINGS["optimizer"]))
    grad_ckpt = bool(
        spec.get("gradient_checkpointing", DEFAULT_TRAIN_SETTINGS["gradient_checkpointing"])
    )
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
        "optimizer": optimizer,
        "gradient_checkpointing": grad_ckpt,
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
        _make_dataset(n_images, resolution, W.DATASET_DIR)
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
                # 途中サンプル生成は shape が変わるたび再コンパイルが走り
                # （~220s）、s/it の測定を壊す。ベンチでは完全に切る。
                "sample_every": 0,
                "save_every": total_steps,
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

        # 壁時計の差分から s/it を出す（tqdm の内部移動平均に依存しない）。
        measured = [p for p in step_samples if p[1] > warmup_steps]
        intervals: list[float] = []
        for (t0, s0), (t1, s1) in zip(measured, measured[1:]):
            ds = s1 - s0
            if ds > 0:
                intervals.append((t1 - t0) / ds)
        spi = _trimmed_mean(intervals)

        result.update(
            {
                "tqdm_unit": sorted(units_seen) or None,
                "spi_steady": round(spi, 4) if spi else None,
                "spi_samples": len(intervals),
                "spi_reported_last": result.pop("_last_reported_spi", None),
                "steps_observed": measured[-1][1] if measured else 0,
                "cache_s": (
                    round(cache_last_ts - cache_first_ts, 1)
                    if cache_first_ts and cache_last_ts
                    else None
                ),
                "wall_s": round(time.time() - launch_ts, 1),
                "returncode": proc.returncode,
                "ok": bool(spi) and not timed_out,
            }
        )
        if not result["ok"] and "error" not in result:
            result["error"] = "定常 s/it を算出できなかった（tail 参照）"
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


def _patch_config(config_path, *, gradient_checkpointing: bool, batch: int, optimizer: str) -> dict:
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
    train["optimizer"] = optimizer

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

    # ベース重みが Volume にあるか（GPU は絶対にダウンロードしない方針）
    missing = {}
    for tm in ("minimax_h3", "qwen_image"):
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
    return {"ok": ok, "cases": results}


# ---------------------------------------------------------------------------
# ハーネス確認（最安 tier）
# ---------------------------------------------------------------------------
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

BENCH_BY_TIER = {
    "b300": bench_b300,
    "b200": bench_b200,
    "h200": bench_h200,
    "rtx_pro_6000": bench_rtx_pro_6000,
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
