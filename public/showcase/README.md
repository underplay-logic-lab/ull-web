# public/showcase/

トップページ（LP）の実績ショーケース用の静的アセット置き場。

`src/components/landing/` の各セクションは `EditableMedia`（admin の Visual Editor で
差し替え）＋ 未設定時の SVG スケルトンで動くので、**画像が未配置でもレイアウトは
破綻しない**。ここに実アセットを置いたら、admin の「📷 メディアを変更」から各
`siteKey` に割り当てる（または下記の想定パスを直接指定）。

## 想定パスと siteKey

| siteKey | 用途 | 推奨 | 想定パス |
|---|---|---|---|
| `hero_visual_url` | ヒーローのメインビジュアル | WebP / MP4, 横長 | `hero/hero.webp` |
| `showcase_ba_before` | Before/After スライダー：他社 i2i 側 | WebP, 16:10 | `before-after/i2i_before.webp` |
| `showcase_ba_after` | Before/After スライダー：ULL Multi-Angle 側 | WebP, 16:10 | `before-after/ull_after.webp` |
| `showcase_turn_front` … `_high` | 360° ターンアラウンド 6 コマ | WebP, 正方形 | `turnaround/00_front.webp` … `05_high.webp` |
| `showcase_swap_before` | 2人挿げ替え：元画像 | WebP, 16:10 | `swap/before.webp` |
| `showcase_swap_after` | 2人挿げ替え：A・B 置換後 | WebP, 16:10 | `swap/after.webp` |

## メモ

- 画像は WebP（品質 80〜90）、動画は H.264 MP4（ミュート・ループ前提）。
- 実写・実キャラの権利に注意。作例は自社生成物のみ。
- 物理型番・ベンダー名を画面に写り込ませない（CLAUDE.md §2）。
