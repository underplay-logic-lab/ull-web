"""ULL Studio 納品ツール用ライセンス（2026-09-30）。

ツールの起動時に ``ensure_license(...)`` を 1 回呼ぶだけで使える。正本は ULL Studio リポジトリの
``tools/ull_license/ull_license.py``。各ツールへはこのファイルをコピーして使う（直すときは正本を直してから配り直す）。

仕組み（サーバー側は src/lib/license/license.server.ts）:
  1. admin が発行したライセンスキーを初回起動時に入力 → ULL Studio がこの PC（HWID）用の署名付きライセンスを返す
  2. ライセンスはツールの隣に ``<product>.license`` として保存。以後は同梱の公開鍵で署名を確かめるだけなのでオフラインで動く
  3. 30 日ごとにオンラインで再確認を試みる（停止・PC の解除を反映）。つながらなければ今のライセンスのまま動く
  4. ネットに出られない PC は「スマホで認証する」→ QR をスマホで読んでキーを入力 → 受け取ったライセンスファイルを PC で「読み込む」
     （それでも困ったら「困ったときは」で HWID を添えて開発者へ → admin の手動発行）

依存は標準ライブラリだけ（Ed25519 の検証も純 Python）。QR コードの表示だけは ``qrcode`` パッケージ（BSD）があれば使い、
無ければ URL を文字で出す。使うツールは requirements に ``qrcode`` を足し、Nuitka に ``--include-package=qrcode`` を付ける。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import sys
import time
import urllib.error
import urllib.request
import uuid
import webbrowser
from pathlib import Path
from typing import Optional

TOKEN_PREFIX = "ULL1."
DEFAULT_API_BASE = "https://www.ullstudio.com"
HTTP_TIMEOUT = 15

# ---------------------------------------------------------------------------
# Ed25519 検証（RFC 8032 の参照実装。検証だけなので定数時間性は不要）
# ---------------------------------------------------------------------------
_P = 2**255 - 19
_Q = 2**252 + 27742317777372353535851937790883648493
_D = -121665 * pow(121666, _P - 2, _P) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _recover_x(y: int, sign: int) -> Optional[int]:
    if y >= _P:
        return None
    x2 = (y * y - 1) * pow(_D * y * y + 1, _P - 2, _P)
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


def _add(a, b):
    A = (a[1] - a[0]) * (b[1] - b[0]) % _P
    B = (a[1] + a[0]) * (b[1] + b[0]) % _P
    C = 2 * a[3] * b[3] * _D % _P
    D = 2 * a[2] * b[2] % _P
    E, F, G, H = B - A, D - C, D + C, B + A
    return (E * F % _P, G * H % _P, F * G % _P, E * H % _P)


def _mul(s: int, pt):
    acc = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            acc = _add(acc, pt)
        pt = _add(pt, pt)
        s >>= 1
    return acc


def _equal(a, b) -> bool:
    return (a[0] * b[2] - b[0] * a[2]) % _P == 0 and (a[1] * b[2] - b[1] * a[2]) % _P == 0


_GY = 4 * pow(5, _P - 2, _P) % _P
_GX = _recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def _decompress(s: bytes):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    if len(public_key) != 32 or len(signature) != 64:
        return False
    a = _decompress(public_key)
    r = _decompress(signature[:32])
    if a is None or r is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _Q:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little") % _Q
    return _equal(_mul(s, _G), _add(r, _mul(h, a)))


# ---------------------------------------------------------------------------
# トークン
# ---------------------------------------------------------------------------
def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def parse_token(token: str, public_key_b64: str) -> Optional[dict]:
    """署名が正しければ payload を返す（期限・HWID は見ない）。"""
    token = (token or "").strip()
    if not token.startswith(TOKEN_PREFIX):
        return None
    head, _, sig = token.rpartition(".")
    if len(head) <= len(TOKEN_PREFIX):
        return None
    try:
        if not ed25519_verify(base64.b64decode(public_key_b64), head.encode("ascii"), _b64url_decode(sig)):
            return None
        payload = json.loads(_b64url_decode(head[len(TOKEN_PREFIX):]).decode("utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) and payload.get("v") == 1 else None


# ---------------------------------------------------------------------------
# HWID（この PC の識別子）: MachineGuid・システムドライブの製造番号・BIOS/マザーボード情報を混ぜて sha256
# ---------------------------------------------------------------------------
def _win_registry(path: str, name: str) -> str:
    try:
        import winreg

        for flag in (winreg.KEY_WOW64_64KEY, 0):
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | flag) as k:
                    val, _ = winreg.QueryValueEx(k, name)
                    return str(val).strip()
            except OSError:
                continue
    except Exception:
        pass
    return ""


def _win_volume_serial() -> str:
    try:
        import ctypes

        serial = ctypes.c_uint32()
        root = os.environ.get("SystemDrive", "C:") + "\\"
        ok = ctypes.windll.kernel32.GetVolumeInformationW(
            ctypes.c_wchar_p(root), None, 0, ctypes.byref(serial), None, None, None, 0
        )
        return f"{serial.value:08x}" if ok else ""
    except Exception:
        return ""


def get_hwid() -> str:
    if sys.platform == "win32":
        bios = r"HARDWARE\DESCRIPTION\System\BIOS"
        parts = [
            _win_registry(r"SOFTWARE\Microsoft\Cryptography", "MachineGuid").lower(),
            _win_volume_serial(),
            _win_registry(bios, "SystemManufacturer"),
            _win_registry(bios, "SystemProductName"),
            _win_registry(bios, "BaseBoardManufacturer"),
            _win_registry(bios, "BaseBoardProduct"),
        ]
    else:
        parts = [platform.node(), f"{uuid.getnode():012x}", platform.machine()]
    return hashlib.sha256(("ull-hwid-v1|" + "|".join(parts)).encode("utf-8")).hexdigest()


def format_hwid(hwid: str) -> str:
    return "-".join(hwid[i : i + 8] for i in range(0, len(hwid), 8)).upper()


def offline_activation_url(api_base: str, product: str, hwid: str) -> str:
    """スマホで開く認証ページ（ULL Studio の /license/offline）。QR コードの中身。"""
    return f"{api_base.rstrip('/')}/license/offline?p={product}&h={hwid}"


def _draw_qr(parent, text: str) -> bool:
    """QR コードを Tk の Canvas に描く。qrcode パッケージが無ければ False（呼び出し側で URL を出す）。

    qrcode（BSD）は行列を作るのに使うだけで、画像ライブラリは使わない。ツールの requirements に
    ``qrcode`` を足し、Nuitka では ``--include-package=qrcode`` を付ける。
    """
    try:
        import qrcode
    except Exception:
        return False
    import tkinter as tk

    qr = qrcode.QRCode(border=3, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(text)
    qr.make(fit=True)
    matrix = qr.get_matrix()
    cell = max(3, 200 // len(matrix))
    size = cell * len(matrix)
    canvas = tk.Canvas(parent, width=size, height=size, bg="#ffffff", highlightthickness=0)
    for y, row in enumerate(matrix):
        for x, on in enumerate(row):
            if on:
                canvas.create_rectangle(x * cell, y * cell, (x + 1) * cell, (y + 1) * cell, fill="#000000", width=0)
    canvas.pack(pady=(4, 10))
    return True


# ---------------------------------------------------------------------------
# 通信
# ---------------------------------------------------------------------------
class LicenseServerError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


def _post(api_base: str, path: str, body: dict, app_name: str) -> dict:
    req = urllib.request.Request(
        api_base.rstrip("/") + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": f"ULL-License/1 ({app_name})"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = {}
        raise LicenseServerError(e.code, str(data.get("code", "")), str(data.get("error") or f"HTTP {e.code}")) from None


# ---------------------------------------------------------------------------
# 本体
# ---------------------------------------------------------------------------
def _check_payload(payload: Optional[dict], product: str, hwid: str, ignore_exp: bool = False) -> Optional[str]:
    """使えないなら理由（日本語）、使えるなら None。"""
    if payload is None:
        return "ライセンスファイルが正しくありません。"
    if payload.get("product") != product:
        return "別のツール用のライセンスファイルです。"
    if payload.get("hwid") != hwid:
        return "このライセンスは別の PC 用です。"
    exp = payload.get("exp")
    if not ignore_exp and isinstance(exp, (int, float)) and time.time() >= exp:
        return "ライセンスの期限が切れています。"
    return None


def ensure_license(
    *,
    product: str,
    public_key_b64: str,
    app_name: str,
    app_dir: str | Path,
    support_url: str = "",
    support_label: str = "開発者に連絡する",
    api_base: str = DEFAULT_API_BASE,
) -> dict:
    """有効なライセンスがあれば payload を返す。無ければ認証画面を出し、認証できなければ終了する。

    DPI 対応（SetProcessDpiAwareness）より後、アプリ本体のウィンドウを作る前に呼ぶこと。
    """
    hwid = get_hwid()
    path = Path(app_dir) / f"{product}.license"
    notice = ""

    if path.exists():
        token = path.read_text(encoding="utf-8", errors="ignore").strip()
        payload = parse_token(token, public_key_b64)
        reason = _check_payload(payload, product, hwid)
        # 期限切れでも、admin が期限を延ばしていればオンラインで新しいライセンスを受け取れる（2026-09-30）。
        expired = payload is not None and reason is not None and _check_payload(payload, product, hwid, ignore_exp=True) is None
        rck = payload.get("rck") if payload else None
        recheck_due = reason is None and isinstance(rck, (int, float)) and time.time() >= rck
        if expired or recheck_due:
            try:
                res = _post(api_base, "/api/license/refresh", {"token": token}, app_name)
                fresh = parse_token(res.get("token", ""), public_key_b64)
                if _check_payload(fresh, product, hwid) is None:
                    path.write_text(res["token"] + "\n", encoding="utf-8")
                    return fresh
            except LicenseServerError as e:
                if e.status in (400, 403, 404):
                    _safe_unlink(path)
                    reason = e.args[0]
            except Exception:
                if expired:
                    reason = "ライセンスの期限が切れています。延長済みの場合は、ネットにつないでから起動し直してください。"
                # 再確認だけならつながらなくても今のライセンスのまま動かす
        if reason is None:
            return payload
        notice = reason

    payload = _show_dialog(
        product=product,
        public_key_b64=public_key_b64,
        app_name=app_name,
        path=path,
        hwid=hwid,
        notice=notice,
        support_url=support_url,
        support_label=support_label,
        api_base=api_base,
    )
    if payload is None:
        sys.exit(1)
    return payload


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def _show_dialog(*, product, public_key_b64, app_name, path, hwid, notice, support_url, support_label, api_base):
    import tkinter as tk
    from tkinter import filedialog

    result: dict = {}
    bg, panel, fg, muted, accent = "#121212", "#1e1e1e", "#eeeeee", "#9a9a9a", "#ff4fa3"

    root = tk.Tk()
    root.title(f"{app_name} - ライセンス認証")
    root.configure(bg=bg)
    root.resizable(False, False)
    root.attributes("-topmost", True)

    def label(text, **kw):
        opts = {"bg": bg, "fg": fg, "font": ("Yu Gothic UI", 10), "justify": "left"}
        opts.update(kw)
        return tk.Label(root, text=text, **opts)

    label(f"{app_name} のライセンス認証", font=("Yu Gothic UI", 13, "bold")).pack(anchor="w", padx=20, pady=(16, 4))
    status = label(notice or "お渡ししたライセンスキーを入力してください。", fg=("#ff7070" if notice else muted), wraplength=440)
    status.pack(anchor="w", padx=20, pady=(0, 10))

    key_var = tk.StringVar()
    entry = tk.Entry(root, textvariable=key_var, font=("Consolas", 12), bg=panel, fg=fg, insertbackground=fg, relief="flat", width=36)
    entry.pack(padx=20, ipady=6, fill="x")
    entry.focus_set()

    def set_status(text, error=True):
        status.config(text=text, fg=("#ff7070" if error else "#4fd18b"))
        root.update_idletasks()

    def accept(token: str) -> bool:
        payload = parse_token(token, public_key_b64)
        reason = _check_payload(payload, product, hwid)
        if reason:
            set_status(reason)
            return False
        path.write_text(token.strip() + "\n", encoding="utf-8")
        result["payload"] = payload
        root.destroy()
        return True

    def activate(_event=None):
        key = key_var.get().strip()
        if not key:
            set_status("ライセンスキーを入力してください。")
            return
        set_status("認証しています…", error=False)
        try:
            res = _post(api_base, "/api/license/activate", {"key": key, "hwid": hwid, "product": product}, app_name)
            accept(res.get("token", ""))
        except LicenseServerError as e:
            set_status(e.args[0])
        except Exception:
            set_status("認証サーバーにつながりませんでした。ネット接続を確認するか、「スマホで認証する」をお使いください。")

    def load_file():
        name = filedialog.askopenfilename(
            parent=root, title="ライセンスファイルを選ぶ", filetypes=[("ライセンスファイル", "*.license"), ("すべて", "*.*")]
        )
        if name:
            accept(Path(name).read_text(encoding="utf-8", errors="ignore"))

    entry.bind("<Return>", activate)
    tk.Button(root, text="認証する", command=activate, bg=accent, fg="#ffffff", font=("Yu Gothic UI", 10, "bold"), relief="flat", pady=6).pack(
        padx=20, pady=(10, 4), fill="x"
    )

    # --- ネットにつながらない PC: QR コード → スマホで認証 → ライセンスファイルを PC に移して読み込む（2026-09-30） ---
    label("ネットにつながらない PC の場合", fg=muted, font=("Yu Gothic UI", 9)).pack(anchor="w", padx=20, pady=(14, 2))
    offline_url = offline_activation_url(api_base, product, hwid)
    offline = tk.Frame(root, bg=panel)

    def toggle_offline():
        if offline.winfo_ismapped():
            offline.pack_forget()
            return
        offline.pack(padx=20, fill="x", after=offline_btn)

    offline_btn = tk.Button(root, text="スマホで認証する（QR コードを表示）", command=toggle_offline, bg="#2c2c2c", fg=fg, relief="flat", pady=4)
    offline_btn.pack(padx=20, fill="x")

    tk.Label(
        offline,
        text=(
            "1. スマホのカメラでこの QR コードを読み取る\n"
            "2. 開いたページでライセンスキーを入力 → ライセンスファイルがスマホに保存される\n"
            "3. そのファイルを USB ケーブル・USB メモリ・クラウド等で PC に移す\n"
            "4. 下の「ライセンスファイルを読み込む」で選ぶ"
        ),
        bg=panel, fg=fg, font=("Yu Gothic UI", 9), justify="left",
    ).pack(anchor="w", padx=10, pady=(8, 4))
    if not _draw_qr(offline, offline_url):
        # QR を作れない環境（qrcode パッケージ無し）では URL を出す。
        url_entry = tk.Entry(offline, font=("Consolas", 8), bg=panel, fg="#00ffcc", relief="flat", readonlybackground=panel)
        url_entry.insert(0, offline_url)
        url_entry.config(state="readonly")
        url_entry.pack(fill="x", padx=10, pady=(0, 8))

    row = tk.Frame(root, bg=bg)
    row.pack(padx=20, pady=(10, 4), fill="x")
    tk.Button(row, text="ライセンスファイルを読み込む", command=load_file, bg="#2c2c2c", fg=fg, relief="flat").pack(side="left")
    tk.Button(row, text="閉じる", command=root.destroy, bg="#2c2c2c", fg=muted, relief="flat").pack(side="right")

    # --- それでも困ったとき: HWID を添えて開発者へ（admin の「手動発行」で対応） ---
    if support_url:
        shown = format_hwid(hwid)

        def contact():
            root.clipboard_clear()
            root.clipboard_append(shown)
            root.update()
            set_status("HWID をコピーしました。問い合わせのメッセージに貼り付けて送ってください。", error=False)
            webbrowser.open(support_url)

        tk.Button(
            root, text=f"困ったときは: {support_label}（HWID をコピーして開きます）", command=contact,
            bg=bg, fg=muted, activebackground=bg, relief="flat", font=("Yu Gothic UI", 8), cursor="hand2",
        ).pack(padx=20, pady=(2, 14), anchor="w")

    root.protocol("WM_DELETE_WINDOW", root.destroy)
    root.mainloop()
    return result.get("payload")
