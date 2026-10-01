"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// Studio の説明ブロック（2026-10-01、説明の整理）。要点 1 行を常に出し、補足は「詳しく ▸」で開く。
//
// 開閉はブラウザに記憶する（per-id の上書き → 全体の既定 → 画面幅の既定 の順）。全体の既定は
// Studio 上部の「説明: すべて開く／すべて畳む」（HelpNoteToggleAll）で切り替え、押すと per-id の上書きは消える。
// 画面幅の既定は、PC は開く・スマホ（640px 未満）は畳む（ホスト了承 2026-09-29）。
//
// 注意・警告（料金がかかる・結果が入れ替わる等）は要点側に書く。「詳しく」に隠してよいのは読まなくても困らない補足だけ。

const KEY_PREFIX = "ull_help_";
const DEFAULT_KEY = `${KEY_PREFIX}_default`;
const EVENT = "ull-help-change";
const MOBILE_QUERY = "(max-width: 639px)";

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 保存できなくても開閉はその場で効かせたいが、記憶は諦める（プライベートモード等）。
  }
  window.dispatchEvent(new Event(EVENT));
};

const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
    mq.removeEventListener("change", cb);
  };
};

const defaultOpen = () => {
  const d = read(DEFAULT_KEY);
  if (d === "1") return true;
  if (d === "0") return false;
  return !window.matchMedia(MOBILE_QUERY).matches;
};

const isOpen = (id: string) => {
  const v = read(KEY_PREFIX + id);
  return v === "1" ? true : v === "0" ? false : defaultOpen();
};

// サーバー描画では畳んだ状態で出す（要点は出るのでレイアウトは大きく跳ねない）。
const serverClosed = () => false;

export function HelpNote({
  id,
  summary,
  children,
  className = "",
  textClass = "text-[10px] text-muted",
  icon,
}: {
  // ブラウザに記憶する開閉のキー。タブ名を頭に付ける（例: "dataset.reference"）。
  id: string;
  summary: ReactNode;
  children?: ReactNode;
  className?: string;
  // 文字サイズと色（既存の説明に合わせる。注意の枠なら text-amber-300 など）。
  textClass?: string;
  // 行頭のアイコン（Multi-Angle などの「✦ 説明」型）。
  icon?: ReactNode;
}) {
  const open = useSyncExternalStore(subscribe, () => isOpen(id), serverClosed);
  const hasMore = children != null && children !== false && children !== "";

  const body = (
    <>
      <p>
        {summary}
        {hasMore && (
          <button
            type="button"
            onClick={(e) => {
              // ドロップ欄など、クリックで別の動作をする枠の中にも置くので親へ伝えない。
              e.stopPropagation();
              write(KEY_PREFIX + id, open ? "0" : "1");
            }}
            aria-expanded={open}
            className="ml-1 inline-flex items-center gap-0.5 whitespace-nowrap text-neon-violet/80 hover:text-neon-violet"
          >
            {open ? "閉じる" : "詳しく"}
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          </button>
        )}
      </p>
      {hasMore && open && <div className="mt-0.5 text-muted/80">{children}</div>}
    </>
  );

  return icon ? (
    <div className={`flex items-start gap-1.5 leading-relaxed ${textClass} ${className}`}>
      {icon}
      <div className="min-w-0">{body}</div>
    </div>
  ) : (
    <div className={`leading-relaxed ${textClass} ${className}`}>{body}</div>
  );
}

// Studio 上部に置く「説明: すべて開く／すべて畳む」。
export function HelpNoteToggleAll({ className = "" }: { className?: string }) {
  const allOpen = useSyncExternalStore(subscribe, defaultOpen, serverClosed);

  const setAll = (value: boolean) => {
    try {
      const drop: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(KEY_PREFIX) && k !== DEFAULT_KEY) drop.push(k);
      }
      drop.forEach((k) => window.localStorage.removeItem(k));
    } catch {
      // 個別の記憶が消せなくても既定の切り替えは試す
    }
    write(DEFAULT_KEY, value ? "1" : "0");
  };

  // 個別に開け閉めした後でも、押せば必ず全部そろうように両方出す。
  return (
    <p className={`text-[11px] text-muted ${className}`}>
      説明:
      <button
        type="button"
        onClick={() => setAll(true)}
        className={`ml-2 underline-offset-2 hover:text-foreground ${allOpen ? "text-foreground" : "underline"}`}
      >
        すべて開く
      </button>
      <span className="mx-1.5 text-muted/50">／</span>
      <button
        type="button"
        onClick={() => setAll(false)}
        className={`underline-offset-2 hover:text-foreground ${!allOpen ? "text-foreground" : "underline"}`}
      >
        すべて畳む
      </button>
    </p>
  );
}
