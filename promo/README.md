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
