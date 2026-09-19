"""
ULL データ保持ポリシー（CLAUDE.md §3）の実施 — 日次 purge。

生成物は一律 14 日で削除する:
  Supabase Storage
    angle-results   … Multi-Angle 出力（旧方式で保存済みの行のみ。2026-09-18〜、
      新規生成分はVolume直接配信へ移行済み、下記参照。移行前の行が14日経過するまでの経過措置）
    upscale-results … 超解像 出力（旧方式で保存済みの行のみ。2026-09-18〜、画像・動画とも
      新規生成分はVolume直接配信へ移行済み、下記参照。移行前の行が14日経過するまでの経過措置）
    lora_datasets   … LoRA 学習用アップロード画像
  Modal Volume (ull-wan-models)
    loras/<lora_name>.safetensors      … 完成 LoRA の名前付きエイリアス
    loras/<user_id>/<job_id>/          … 学習ジョブごとの成果物（checkpoint 等）
    upscale_originals/<user_id>/<job_id>/  … WebP劣化前の元PNG（超解像、2026-09-14〜）
    director_results/<user_id>/<job_id>.mp4      … Cinematic Director 動画結果
      （CLAUDE.md §1「大容量バイナリはSupabaseを経由させない」標準、2026-09-18〜。
      modal_wan_animate_blackwell.py::download_director_video が配信する実体）
    upscale_video_results/<user_id>/<job_id>.mp4 … 超解像動画 結果（同標準、2026-09-18〜。
      modal_seedvr2_worker.py::download_upscale_video が配信する実体）
    upscale_image_results/<user_id>/<job_id>.<ext> … 超解像画像 結果（同標準、2026-09-18〜。
      modal_seedvr2_worker.py::download_upscale_image が配信する実体）
    angle_results/<user_id>/<job_id>/<index>.png … Multi-Angle 結果（同標準、2026-09-18〜。
      modal_angle_worker.py::download_angle_image が配信する実体。1ジョブ=1ディレクトリ）
    custom_workflow_results/<user_id>/<job_id>.<ext> … 特化ワークフロー 結果（同標準、2026-09-18〜。
      scripts/modal_wan_animate.py::download_custom_workflow_result が配信する実体）
    director_user_loras/<user_id>/<filename>.safetensors … Director外部アップロードLoRA
      （2026-09-18導入・2026-09-19〜14日パージ対象化。当初「入力データなので保持期限
      なし」だったが、連続生成のたびに新規UUIDファイル名で重複が無期限に積み上がる
      欠陥があったため、他の入力データ(lora_datasets等)と同じ14日ルールに揃えた）
  Supabase DB
    angle_jobs / upscale_jobs / generation_jobs の古い行

⚠️ loras/ 直下の「フラットファイル」は preset が依存するベース LoRA
   （lightx2v 等）が含まれるので、**generation_jobs.result_path が指すもの**
   と **UUID 形のサブディレクトリ** だけを消す（mtime の全掃きはしない）。

運用:
  # 手動 dry-run（何も消さずログだけ）
  ULL_RETENTION_DRY_RUN=1 PYTHONIOENCODING=utf-8 PYTHONUTF8=1 \
    modal run modal_retention_purge.py::run_once
  # デプロイ（日次スケジュール有効化）
  PYTHONIOENCODING=utf-8 PYTHONUTF8=1 modal deploy modal_retention_purge.py

Env:
  ULL_RETENTION_DAYS       保持日数（既定 14）
  ULL_RETENTION_DRY_RUN    "1" で削除せずログのみ
  ULL_RETENTION_BUCKETS    カンマ区切りで対象バケットを上書き
"""

import os
import re
import shutil
import time

import modal

app = modal.App("ull-retention-purge")

MODELS_DIR = "/models"
LORA_DIR = f"{MODELS_DIR}/loras"
# 2026-09-14: modal_seedvr2_worker.py の _persist_upscale_original が、WebP
# 再エンコードで失われる元PNGをここへ退避する（loras/<uid>/<jobid>/ と同じ
# per-job ディレクトリ規約・DB参照なしの純粋な mtime ベース孤児掃除）。
UPSCALE_ORIGINALS_DIR = f"{MODELS_DIR}/upscale_originals"
# 2026-09-18: CLAUDE.md §1「大容量バイナリはSupabaseを経由させない」標準の
# 適用第1弾・第2弾。Director/超解像動画の結果はもうSupabase Storageへ
# アップロードせず、Volumeへ直接保存して署名付きURLで配信する
# （download_director_video / download_upscale_video）。どちらも
# <user_id>/<job_id>.mp4 のフラットファイル（upscale_originals/のような
# per-jobディレクトリではない）なので専用のpurgeヘルパーを使う。
DIRECTOR_RESULTS_DIR = f"{MODELS_DIR}/director_results"
UPSCALE_VIDEO_RESULTS_DIR = f"{MODELS_DIR}/upscale_video_results"
UPSCALE_IMAGE_RESULTS_DIR = f"{MODELS_DIR}/upscale_image_results"
# 2026-09-18: Multi-Angle も同標準を適用。angle_results/<uid>/<jobid>/ は
# 1ジョブにつき複数PNG（8〜96構図）を持つ per-job ディレクトリなので、
# upscale_originals と同じ「ディレクトリ単位のmtime孤児掃除」ロジックを使う
# （flatファイル用の _purge_volume_flat_files ではなく後述の
# _purge_volume_job_dirs を再利用）。
ANGLE_RESULTS_DIR = f"{MODELS_DIR}/angle_results"
# 2026-09-18: 特化ワークフロー（scripts/modal_wan_animate.py の
# custom_workflow、"標準"/L40S ティアの WanAnimate クラス）も同標準を適用。
# 1ジョブ=1ファイルのflat配置なので _purge_volume_flat_files を使う。
CUSTOM_WORKFLOW_RESULTS_DIR = f"{MODELS_DIR}/custom_workflow_results"
# 2026-09-19: Cinematic Directorの外部アップロードLoRA（modal_lora_worker.py::
# upload_user_lora、director_user_loras/<user_id>/<filename>）。導入時は
# 「入力データなので保持期限なし」という整理で意図的にここへ入れていな
# かったが、フロント側の再アップロード（uploadDirectorLoraFile、Fileオブ
# ジェクトが変わるたびに新規UUIDファイル名で保存）のたびに重複が無期限に
# 積み上がる欠陥があったと判明（ホスト指摘）。lora_datasets（LoRA学習用の
# 入力画像）等、他の「ユーザー入力データ」も等しく14日パージ対象にして
# いるプロジェクト全体の方針と揃え、こちらも対象に含める。
DIRECTOR_USER_LORAS_DIR = f"{MODELS_DIR}/director_user_loras"

# 2026-09-19（ホスト指示）: 管理者アカウント（ADMIN_EMAILS）の生成物は自動削除
# 対象外にする。ADMIN_EMAILS 自体は Next.js 側の管理画面ログイン許可リストで
# ここ（独立した Modal 日次バッチ）からは参照できないため、対応する
# auth.users.id を直接ハードコードしている。admin を追加/削除したら
# ここも合わせて更新すること。
ADMIN_USER_IDS = {
    "e1e2ddb2-fd73-4feb-b789-76640d999b4b",  # underplay.project@gmail.com
    "726453dc-7c51-4be3-94ef-5df97a7a2075",  # axelbh5@gmail.com
    "696f4941-b97e-4096-85a6-c78c72c82173",  # t-numazaki@mud.biglobe.ne.jp
}

RETENTION_DAYS = int(os.environ.get("ULL_RETENTION_DAYS", "14"))
# _purge() が実行時に上書きする（module import 時の env はコンテナに無いため、
# ここでの評価はスケジュール実行の既定値でしかない）。run_once の DRY 引数、
# または env ULL_RETENTION_DRY_RUN で切り替え。
DRY_RUN = os.environ.get("ULL_RETENTION_DRY_RUN", "") in ("1", "true", "yes")

DEFAULT_BUCKETS = [
    "angle-results", "upscale-results", "lora_datasets", "custom-workflow-results",
    # 2026-09-17: Cinematic Director を video_url への base64 直埋め込みから
    # Storage バケット方式へ移行（[[cinematic-video-tab]] 系の旧privacy posture
    # は現行 DirectorStudioTab.tsx には無く、CLAUDE.md §6 の標準へ統一）。
    "director-results",
    # 2026-09-13: upscale/generate・upscale/batch route.ts が一時アップロード
    # （upscale-uploads）を dispatch 直後に即削除していたのを撤去した（Modal
    # worker が署名付きURLを fetch する前にオブジェクトが消えるレース条件で
    # 実障害が出た）。削除しない代わりにここで14日自動パージの対象に含める。
    "upscale-uploads",
]

# job テーブル → 対応バケット（ストレージ側は created_at 全掃きなので、ここは
# 行削除の対象一覧）。
JOB_TABLES = ["angle_jobs", "upscale_jobs", "generation_jobs"]

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "requests", "fastapi[standard]"
)

vol = modal.Volume.from_name("ull-wan-models", create_if_missing=True)


# ---------------------------------------------------------------------------
# Supabase REST / Storage ヘルパー
# ---------------------------------------------------------------------------
def _env():
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未設定")
    return url, key


def _headers():
    _url, key = _env()
    return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _rest(method: str, path: str, **kwargs):
    import requests

    url, _key = _env()
    return requests.request(
        method, f"{url}{path}", headers={**_headers(), **kwargs.pop("headers", {})},
        timeout=30, **kwargs,
    )


def _storage_list(bucket: str, prefix: str, limit=1000, offset=0):
    """1 階層ぶんの直下エントリ。フォルダは id=None。"""
    import requests

    url, _key = _env()
    res = requests.post(
        f"{url}/storage/v1/object/list/{bucket}",
        headers=_headers(),
        json={"prefix": prefix, "limit": limit, "offset": offset,
              "sortBy": {"column": "name", "order": "asc"}},
        timeout=30,
    )
    res.raise_for_status()
    return res.json()


def _storage_remove(bucket: str, paths: list) -> int:
    import requests

    if not paths:
        return 0
    if DRY_RUN:
        return len(paths)
    url, _key = _env()
    removed = 0
    for i in range(0, len(paths), 100):
        chunk = paths[i:i + 100]
        res = requests.delete(
            f"{url}/storage/v1/object/{bucket}",
            headers=_headers(),
            json={"prefixes": chunk},
            timeout=60,
        )
        res.raise_for_status()
        removed += len(chunk)
    return removed


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _cutoff_iso() -> str:
    return time.strftime(
        "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - RETENTION_DAYS * 86400)
    )


def _cutoff_epoch() -> float:
    return time.time() - RETENTION_DAYS * 86400


# ---------------------------------------------------------------------------
# 1) Supabase バケット: created_at が cutoff より前のファイルを全掃き
# ---------------------------------------------------------------------------
def _sweep_bucket(bucket: str, cutoff_epoch: float) -> dict:
    removed_paths: list = []
    stack = [""]
    scanned = 0

    while stack:
        prefix = stack.pop()
        offset = 0
        while True:
            try:
                entries = _storage_list(bucket, prefix, offset=offset)
            except Exception as exc:  # noqa: BLE001
                print(f"[purge][{bucket}] list '{prefix}' 失敗: {exc}", flush=True)
                break
            if not entries:
                break
            for e in entries:
                name = e.get("name")
                if not name:
                    continue
                # トップレベル（prefix=="")はユーザーフォルダ = user_id。admin
                # フォルダはサブツリーごとスキャン対象から外す(=削除しない)。
                if prefix == "" and name in ADMIN_USER_IDS:
                    continue
                full = f"{prefix}/{name}" if prefix else name
                if e.get("id") is None:
                    stack.append(full)
                    continue
                scanned += 1
                ts = e.get("created_at") or e.get("updated_at")
                try:
                    epoch = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
                except Exception:  # noqa: BLE001
                    epoch = None
                if epoch is not None and epoch < cutoff_epoch:
                    removed_paths.append(full)
            if len(entries) < 1000:
                break
            offset += 1000

    n = _storage_remove(bucket, removed_paths)
    print(
        f"[purge][{bucket}] scanned={scanned} removed={n}"
        f"{' (DRY_RUN)' if DRY_RUN else ''}",
        flush=True,
    )
    return {"bucket": bucket, "scanned": scanned, "removed": n}


# ---------------------------------------------------------------------------
# 2) Modal Volume loras/: 期限切れ generation_jobs から result_path と
#    per-job ディレクトリを消す + UUID 形の孤児ディレクトリを mtime で掃除
# ---------------------------------------------------------------------------
def _purge_volume_loras(cutoff_epoch: float) -> dict:
    import pathlib

    removed_files = 0
    removed_dirs = 0
    lora_root = pathlib.Path(LORA_DIR)
    if not lora_root.is_dir():
        return {"removed_files": 0, "removed_dirs": 0}

    # 期限切れ lora_training ジョブの result_path（= loras/<name>.safetensors）。
    try:
        res = _rest(
            "GET",
            "/rest/v1/generation_jobs",
            params={
                "select": "id,user_id,result_path",
                "workflow_type": "eq.lora_training",
                "created_at": f"lt.{_cutoff_iso()}",
            },
        )
        rows = res.json() if res.ok else []
    except Exception as exc:  # noqa: BLE001
        print(f"[purge][loras] generation_jobs 取得失敗: {exc}", flush=True)
        rows = []

    for row in rows:
        if row.get("user_id") in ADMIN_USER_IDS:
            continue
        rp = (row.get("result_path") or "").strip()
        # 名前付きエイリアス（loras/ 直下のフラットファイルのみ）。
        if rp.endswith(".safetensors"):
            p = pathlib.Path(rp if rp.startswith("/") else f"{MODELS_DIR}/{rp}")
            try:
                if p.is_file() and p.parent == lora_root:
                    if not DRY_RUN:
                        p.unlink()
                    removed_files += 1
                    print(f"[purge][loras] alias {p.name}{' (DRY)' if DRY_RUN else ''}", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"[purge][loras] alias 削除失敗 {p}: {exc}", flush=True)
        # per-job ディレクトリ loras/<uid>/<jobid>/
        uid, jid = row.get("user_id"), row.get("id")
        if uid and jid:
            d = lora_root / str(uid) / str(jid)
            try:
                if d.is_dir():
                    if not DRY_RUN:
                        shutil.rmtree(d, ignore_errors=True)
                    removed_dirs += 1
                    print(f"[purge][loras] jobdir {uid}/{jid}{' (DRY)' if DRY_RUN else ''}", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"[purge][loras] jobdir 削除失敗 {d}: {exc}", flush=True)

    # 孤児ディレクトリ（UUID 形・mtime が cutoff より前）。行が既に消えている
    # ユーザー削除ケースを拾う。ベース LoRA はフラットファイルなので無傷。
    for uid_dir in lora_root.iterdir():
        if not uid_dir.is_dir() or not _UUID_RE.match(uid_dir.name):
            continue
        if uid_dir.name in ADMIN_USER_IDS:
            continue
        for job_dir in list(uid_dir.iterdir()):
            try:
                if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff_epoch:
                    if not DRY_RUN:
                        shutil.rmtree(job_dir, ignore_errors=True)
                    removed_dirs += 1
                    print(
                        f"[purge][loras] orphan {uid_dir.name}/{job_dir.name}"
                        f"{' (DRY)' if DRY_RUN else ''}",
                        flush=True,
                    )
            except Exception:  # noqa: BLE001
                pass
        try:
            if not any(uid_dir.iterdir()) and not DRY_RUN:
                uid_dir.rmdir()
        except Exception:  # noqa: BLE001
            pass

    if (removed_files or removed_dirs) and not DRY_RUN:
        try:
            vol.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[purge][loras] vol.commit skipped: {exc}", flush=True)

    print(
        f"[purge][loras] files={removed_files} dirs={removed_dirs}"
        f"{' (DRY_RUN)' if DRY_RUN else ''}",
        flush=True,
    )
    return {"removed_files": removed_files, "removed_dirs": removed_dirs}


# ---------------------------------------------------------------------------
# 2b) Modal Volume upscale_originals/: per-job ディレクトリを mtime で掃除。
#     loras/ と違い DB の result_path 参照が無い純粋な副産物（download_upscale_
#     original が404を返すようになるだけで、劣化版は upscale-results 側に残る
#     ので実害なし）なので、孤児ディレクトリ掃除と同じロジックのみでよい。
# ---------------------------------------------------------------------------
def _purge_volume_upscale_originals(cutoff_epoch: float) -> dict:
    import pathlib

    removed_dirs = 0
    root = pathlib.Path(UPSCALE_ORIGINALS_DIR)
    if not root.is_dir():
        return {"removed_dirs": 0}

    for uid_dir in list(root.iterdir()):
        if not uid_dir.is_dir() or uid_dir.name in ADMIN_USER_IDS:
            continue
        for job_dir in list(uid_dir.iterdir()):
            try:
                if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff_epoch:
                    if not DRY_RUN:
                        shutil.rmtree(job_dir, ignore_errors=True)
                    removed_dirs += 1
                    print(
                        f"[purge][upscale_originals] {uid_dir.name}/{job_dir.name}"
                        f"{' (DRY)' if DRY_RUN else ''}",
                        flush=True,
                    )
            except Exception:  # noqa: BLE001
                pass
        try:
            if not any(uid_dir.iterdir()) and not DRY_RUN:
                uid_dir.rmdir()
        except Exception:  # noqa: BLE001
            pass

    if removed_dirs and not DRY_RUN:
        try:
            vol.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[purge][upscale_originals] vol.commit skipped: {exc}", flush=True)

    print(
        f"[purge][upscale_originals] dirs={removed_dirs}{' (DRY_RUN)' if DRY_RUN else ''}",
        flush=True,
    )
    return {"removed_dirs": removed_dirs}


# ---------------------------------------------------------------------------
# 2b-2) upscale_originals と同じ「per-job ディレクトリを mtime で掃除」ロジック
#     の汎用版。angle_results/<uid>/<jobid>/ のように1ジョブ=1ディレクトリ・
#     複数ファイルの配置に使う（flatファイル用の _purge_volume_flat_files とは
#     区別する）。
# ---------------------------------------------------------------------------
def _purge_volume_job_dirs(root_dir: str, cutoff_epoch: float, label: str) -> dict:
    import pathlib

    removed_dirs = 0
    root = pathlib.Path(root_dir)
    if not root.is_dir():
        return {"removed_dirs": 0}

    for uid_dir in list(root.iterdir()):
        if not uid_dir.is_dir() or uid_dir.name in ADMIN_USER_IDS:
            continue
        for job_dir in list(uid_dir.iterdir()):
            try:
                if job_dir.is_dir() and job_dir.stat().st_mtime < cutoff_epoch:
                    if not DRY_RUN:
                        shutil.rmtree(job_dir, ignore_errors=True)
                    removed_dirs += 1
                    print(
                        f"[purge][{label}] {uid_dir.name}/{job_dir.name}{' (DRY)' if DRY_RUN else ''}",
                        flush=True,
                    )
            except Exception:  # noqa: BLE001
                pass
        try:
            if not any(uid_dir.iterdir()) and not DRY_RUN:
                uid_dir.rmdir()
        except Exception:  # noqa: BLE001
            pass

    if removed_dirs and not DRY_RUN:
        try:
            vol.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[purge][{label}] vol.commit skipped: {exc}", flush=True)

    print(f"[purge][{label}] dirs={removed_dirs}{' (DRY_RUN)' if DRY_RUN else ''}", flush=True)
    return {"removed_dirs": removed_dirs}


# ---------------------------------------------------------------------------
# 2c) Modal Volume の "<user_id>/<job_id>.<ext>" フラットファイル配置を mtime
#     で掃除する汎用ヘルパー。director_results/ と upscale_video_results/ は
#     どちらもDB参照の無い純粋な副産物（ダウンロードエンドポイントが404を
#     返すようになるだけ）なので、upscale_originals と同じ「孤児掃除のみ」
#     ロジックで足りる。ディレクトリではなくファイル単位である点だけが違う。
# ---------------------------------------------------------------------------
def _purge_volume_flat_files(root_dir: str, cutoff_epoch: float, label: str) -> dict:
    import pathlib

    removed_files = 0
    root = pathlib.Path(root_dir)
    if not root.is_dir():
        return {"removed_files": 0}

    for uid_dir in list(root.iterdir()):
        if not uid_dir.is_dir() or uid_dir.name in ADMIN_USER_IDS:
            continue
        for f in list(uid_dir.iterdir()):
            try:
                if f.is_file() and f.stat().st_mtime < cutoff_epoch:
                    if not DRY_RUN:
                        f.unlink()
                    removed_files += 1
                    print(f"[purge][{label}] {uid_dir.name}/{f.name}{' (DRY)' if DRY_RUN else ''}", flush=True)
            except Exception:  # noqa: BLE001
                pass
        try:
            if not any(uid_dir.iterdir()) and not DRY_RUN:
                uid_dir.rmdir()
        except Exception:  # noqa: BLE001
            pass

    if removed_files and not DRY_RUN:
        try:
            vol.commit()
        except Exception as exc:  # noqa: BLE001
            print(f"[purge][{label}] vol.commit skipped: {exc}", flush=True)

    print(f"[purge][{label}] files={removed_files}{' (DRY_RUN)' if DRY_RUN else ''}", flush=True)
    return {"removed_files": removed_files}


# ---------------------------------------------------------------------------
# 3) DB: 古いジョブ行を削除
# ---------------------------------------------------------------------------
def _purge_job_rows(cutoff_iso: str) -> dict:
    # PostgREST の not.in.(...) フィルタで admin の user_id を除外する。
    admin_filter = "(" + ",".join(sorted(ADMIN_USER_IDS)) + ")"
    out = {}
    for table in JOB_TABLES:
        try:
            if DRY_RUN:
                res = _rest(
                    "GET", f"/rest/v1/{table}",
                    params={
                        "select": "id",
                        "created_at": f"lt.{cutoff_iso}",
                        "user_id": f"not.in.{admin_filter}",
                    },
                    headers={"Prefer": "count=exact", "Range": "0-0"},
                )
                cnt = res.headers.get("content-range", "*/0").split("/")[-1]
                out[table] = f"{cnt} (DRY_RUN)"
                print(f"[purge][{table}] {cnt} 行が対象 (DRY_RUN)", flush=True)
                continue
            res = _rest(
                "DELETE", f"/rest/v1/{table}",
                params={
                    "created_at": f"lt.{cutoff_iso}",
                    "user_id": f"not.in.{admin_filter}",
                },
                headers={"Prefer": "return=representation"},
            )
            deleted = len(res.json()) if res.ok else 0
            out[table] = deleted
            print(f"[purge][{table}] {deleted} 行削除", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"[purge][{table}] 失敗: {exc}", flush=True)
            out[table] = f"error: {exc}"
    return out


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------
def _purge(dry_run: bool | None = None) -> dict:
    global DRY_RUN
    if dry_run is not None:
        DRY_RUN = bool(dry_run)
    started = time.time()
    cutoff_iso = _cutoff_iso()
    cutoff_epoch = _cutoff_epoch()
    print(
        f"[purge] start {_now_iso()} — 保持 {RETENTION_DAYS}日 / cutoff {cutoff_iso}"
        f"{' / DRY_RUN' if DRY_RUN else ''}",
        flush=True,
    )
    try:
        vol.reload()
    except Exception as exc:  # noqa: BLE001
        print(f"[purge] vol.reload skipped: {exc}", flush=True)

    buckets = [
        b.strip()
        for b in os.environ.get("ULL_RETENTION_BUCKETS", ",".join(DEFAULT_BUCKETS)).split(",")
        if b.strip()
    ]

    report = {
        "dry_run": DRY_RUN,
        "retention_days": RETENTION_DAYS,
        "buckets": [],
        "rows": {},
        "loras": {},
        "upscale_originals": {},
        "director_results": {},
        "upscale_video_results": {},
        "upscale_image_results": {},
        "angle_results": {},
        "custom_workflow_results": {},
        "director_user_loras": {},
    }
    for b in buckets:
        report["buckets"].append(_sweep_bucket(b, cutoff_epoch))
    report["loras"] = _purge_volume_loras(cutoff_epoch)
    report["upscale_originals"] = _purge_volume_upscale_originals(cutoff_epoch)
    report["director_results"] = _purge_volume_flat_files(DIRECTOR_RESULTS_DIR, cutoff_epoch, "director_results")
    report["upscale_video_results"] = _purge_volume_flat_files(
        UPSCALE_VIDEO_RESULTS_DIR, cutoff_epoch, "upscale_video_results"
    )
    report["upscale_image_results"] = _purge_volume_flat_files(
        UPSCALE_IMAGE_RESULTS_DIR, cutoff_epoch, "upscale_image_results"
    )
    report["angle_results"] = _purge_volume_job_dirs(ANGLE_RESULTS_DIR, cutoff_epoch, "angle_results")
    report["custom_workflow_results"] = _purge_volume_flat_files(
        CUSTOM_WORKFLOW_RESULTS_DIR, cutoff_epoch, "custom_workflow_results"
    )
    report["director_user_loras"] = _purge_volume_flat_files(
        DIRECTOR_USER_LORAS_DIR, cutoff_epoch, "director_user_loras"
    )
    report["rows"] = _purge_job_rows(cutoff_iso)
    report["elapsed_s"] = round(time.time() - started, 1)
    print(f"[purge] done in {report['elapsed_s']}s: {report}", flush=True)
    return report


@app.function(
    image=image,
    volumes={MODELS_DIR: vol},
    schedule=modal.Period(days=1),
    timeout=1800,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("supabase-model-downloads")],
)
def purge_expired() -> dict:
    """日次スケジュール実行。"""
    return _purge()


@app.function(
    image=image,
    volumes={MODELS_DIR: vol},
    timeout=1800,
    scaledown_window=2,
    secrets=[modal.Secret.from_name("supabase-model-downloads")],
)
def run_once_fn(dry_run: bool = True) -> dict:
    return _purge(dry_run=dry_run)


@app.local_entrypoint()
def run_once(dry: bool = True):
    """modal run modal_retention_purge.py::run_once            … dry-run（既定）
       modal run modal_retention_purge.py::run_once --dry false … 実削除"""
    import json

    print(json.dumps(run_once_fn.remote(dry_run=dry), ensure_ascii=False, indent=2))
