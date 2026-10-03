# ULL Studio 紹介動画（Remotion）

絵コンテ: `../docs/promo-video-storyboard.md`。Next 本体とは別プロジェクト（依存は `promo/node_modules`、本体の tsc / eslint 対象外）。

## 使い方

```sh
cd promo
npm install
npm run studio            # ブラウザでプレビュー（尺・テロップをその場で確認）
npm run render:short      # out/short.mp4（9:16・30 秒）
npm run render:landscape  # out/landscape.mp4（16:9・90 秒）
```

## 素材の差し込み

1. ファイルを `public/` に置く（画像でも動画でもよい）。
2. `src/assets.ts` の該当箇所の `null` をファイル名に変える。
3. `null` のままの所は仮の枠（ラベル付き）で描かれる。

尺とテロップは `src/Root.tsx`（`shortParts` / `landscapeParts`）。各場面の見た目は `src/scenes.tsx`。

## 注意

- 画面に GPU 型番・ベンダー名・基盤モデル名を出さない（CLAUDE.md §2）。人物は自前生成の顔だけ。
- Remotion は個人・社員 3 人以下の会社なら無料、それを超えると会社ライセンスが要る（remotion.dev/license）。
- 生成素材（`public/` の画像・動画）は重いので git に入れない。

## 操作動画（C）の録画と書き出し

本物の画面を人が操作して録る。ズーム・カーソル・クリックの波紋・待ち時間の早送り・テロップは後から自動で乗る。

```sh
node scripts/record.mjs login                    # 初回だけ: 普通の Chrome が開く。テスト用アカウントでログインして閉じる（.rec-profile/ に残る。自動操作中だと Turnstile に弾かれるため）
node scripts/record.mjs dataset https://www.ullstudio.com/studio?tab=dataset
#   → 普通に操作する。説明を入れたい所で F8 → 出た欄に入れたいテロップをメモして Enter（欄が出ている間は録画が止まる。Esc で取り消し）。終わったらブラウザを閉じる
#   → public/rec/dataset/ に frames/・session.json・edit.json
npx remotion render Tutorial out/dataset.mp4 --props='{"session":"dataset"}'
node scripts/record.mjs demo https://www.ullstudio.com/   # 仕組みの動作確認（自動で動いて閉じる）
```

- `edit.json` を手で直す: `title`（冒頭 2.5 秒）、`captions[]`（`at` は録画の秒・F8 の位置が入っている。`memo` はそのとき書いたメモで画面には出ない。`text` が空なら出ない。
  `dur` 表示秒・`zoom: 1` でその間は引き）、`trimStart`/`trimEnd`、`idleGap`（既定 6 秒操作が無ければ早送り）、`zoom`（クリック時の倍率、既定 1.6）。
- 何を打ったかは記録しない（キーは「押した」ことだけ）。画面に出るメールアドレス等はテスト用アカウントで避ける。
- 録画は 30fps 上限で約 2MB/秒（10 分で 1.2GB）。`public/` なので git には入らない。
- 画質を上げたいとき `REC_DPR=2`（既定 1.5）。

## ブランド素材（SNS のアイコン・バナー）

`node brand/render.mjs` → `out/brand/`。採用案（黒 × 明朝、2026-10-01）は `youtube-icon.png`・`youtube-banner.png`。
`sheet.png` は案の見比べ用。色・書体・一行は `brand/render.mjs` の先頭（`PALETTE` / `TYPE` / `MAIN`）。

## 仕上げ（4K・BGM・クリック音、2026-10-02）

- 共通 BGM は `public/audio/bgm.wav`（MiniMax Music 3 で作った静かなピアノ・歌なし。`modal_music_worker.py`）。クリック音は `python scripts/make_click.py`。
- 部分ごとに `edit.json` に `"bgm": null` を書き、4K で書き出す: `npx remotion render Tutorial out/a.mp4 --props='{"session":"<名前>"}' --scale=2 --crf=16`
  （1440p の倍率 4/3 は割り切れず書き出せない。YouTube は 4K で上げると 1080p 視聴でも画質が良い）
- つないで BGM を通しで重ねる: `python scripts/finish_video.py out/<完成>.mp4 out/a.mp4 out/b.mp4`
- 録画用 Chrome は完了直後にページが閉じていた → 原因は**ダウンロード**（この録画用プロファイルではダウンロード開始でブラウザごと落ちる。自動保存・ZIP・チェックポイント DL）。
  2026-10-03 から `record.mjs` が録画中のダウンロードを断るので落ちない（ファイルは保存されない。画面はそのまま）。
