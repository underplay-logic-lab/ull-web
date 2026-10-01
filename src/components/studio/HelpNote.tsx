"use client";

import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

// Studio の説明ブロック（2026-10-01、説明の整理）。
//
// 基本は「項目名 ▸」だけを出し、押すと説明（要点＋補足）が開く（ホスト判断 2026-10-01: 初見でどれだけシンプルに
// 見えるかを優先。分からなくなったときに開けば詳しく書いてある状態）。title を渡さないものは従来どおり要点を常に出し、
// 補足だけ「詳しく ▸」で開く — 料金・所要時間の注意や、間違えると困る指示はこちら（畳むと事故になる）。
// notice は開閉に関係なく常に出す（条件付きの警告など）。
//
// 開閉はブラウザに記憶する（部分ごとの記憶 → 全体の既定 → 閉じる の順）。全体の既定は Studio 上部の
// 「説明: すべて開く／すべて畳む」（HelpNoteToggleAll）で切り替え、押すと部分ごとの記憶は消える。

const KEY_PREFIX = "ull_help_";
const DEFAULT_KEY = `${KEY_PREFIX}_default`;
const EVENT = "ull-help-change";

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
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
};

const defaultOpen = () => read(DEFAULT_KEY) === "1";

const isOpen = (id: string) => {
  const v = read(KEY_PREFIX + id);
  return v === "1" ? true : v === "0" ? false : defaultOpen();
};

// サーバー描画では畳んだ状態で出す（既定も閉じるなのでレイアウトは跳ねない）。
const serverClosed = () => false;

export function HelpNote({
  id,
  title,
  summary,
  children,
  notice,
  className = "",
  textClass = "text-[10px] text-muted",
  icon,
}: {
  // ブラウザに記憶する開閉のキー。タブ名を頭に付ける（例: "dataset.reference"）。
  id: string;
  // 畳んだときに出す項目名（何の説明か）。無ければ要点を常に出す。
  title?: string;
  summary: ReactNode;
  children?: ReactNode;
  // 開閉に関係なく常に出す（条件付きの警告など）。
  notice?: ReactNode;
  className?: string;
  // 文字サイズと色（既存の説明に合わせる。注意の枠なら text-amber-300 など）。
  textClass?: string;
  // 行頭のアイコン（Multi-Angle などの「✦ 説明」型）。
  icon?: ReactNode;
}) {
  const open = useSyncExternalStore(subscribe, () => isOpen(id), serverClosed);
  const hasMore = children != null && children !== false && children !== "";

  const toggle = (e: MouseEvent) => {
    // ドロップ欄など、クリックで別の動作をする枠の中にも置くので親へ伝えない。
    e.stopPropagation();
    write(KEY_PREFIX + id, open ? "0" : "1");
  };
  const chevron = open ? <ChevronDown size={10} /> : <ChevronRight size={10} />;

  const body = title ? (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="inline-flex items-center gap-0.5 text-left text-neon-violet/80 hover:text-neon-violet"
      >
        {title}
        {chevron}
      </button>
      {notice && <p>{notice}</p>}
      {open && (
        <div className="mt-0.5">
          <p>{summary}</p>
          {hasMore && <div className="text-muted/80">{children}</div>}
        </div>
      )}
    </>
  ) : (
    <>
      <p>
        {summary}
        {notice}
        {hasMore && (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="ml-1 inline-flex items-center gap-0.5 whitespace-nowrap text-neon-violet/80 hover:text-neon-violet"
          >
            {open ? "閉じる" : "詳しく"}
            {chevron}
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
