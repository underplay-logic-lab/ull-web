# モデル ＆ OSS ライセンス判定リスト

CLAUDE.md §5（商用利用・SaaS再頒布・地域制限の3点を満たすものだけ採用する）の判定済みリスト。
**新しいモデル・推論コード・レンダラ・依存ライブラリを採用したら、ここへ追記すること。**

**不可（本番採用禁止）**
- 非商用ライセンス（CC-BY-NC、"research only"、FLUX.1 `[dev]`、**FLUX.1 Kontext `[dev]`** 等）。Kontext は BFL の有償商用ライセンスまたは Pro/Max API 経由でのみ商用可 → 自ホスト採用は不可。
- **`nvdiffrast` / `nvdiffrec`**（NVIDIA Source Code License = 非商用）。3Dレンダリングは商用可のものを使う: 3D Gaussian Splatting 出力を **`gsplat`（Apache-2.0）**、メッシュは PyTorch3D（BSD）/ Kaolin（Apache-2.0）。Inria版3DGSラスタライザ（`diff-gaussian-rasterization`）も研究用途限定で不可。

**可（確認済み・商用OK）**
- **Qwen-Image / Qwen-Image-Edit-2511**: Apache-2.0。現行の画像編集・リスタイルの基盤。
- **Microsoft TRELLIS / TRELLIS.2（`microsoft/TRELLIS.2-4B`）**: MIT。image→3D の第一候補（非商用レンダラ依存は上記のとおり回避）。
- **Wan2.2-S2V-14B**: Apache-2.0・地域制限なし。ただし**速度・品質とも本番採用の水準に届かず不採用**（`docs/gpu-benchmarks.md` §10）。

**要注意（地域制限あり・原則回避）**
- **Hunyuan3D 2.1**: 重み＋学習コード公開だが **EU・英国・韓国で利用不可**、MAU1億超で別途ライセンス要、NOTICE同梱義務。グローバル公開サービスでは原則採用しない（TRELLIS優先）。品質面で必要なら geofence 前提でホスト承認を取る。
- **Hunyuan3D 3.0 / 3.1**: プロプライエタリ（Tencent Cloud API のみ、重み非公開）。自ホスト不可で「Blackwell 自ホスト」の売りと矛盾するため採用しない。


---

## 判定の手順

1. ライセンス本文を読む（README のバッジやHugging Faceのタグだけで判断しない）。
2. **商用利用・SaaS としての再頒布・地域制限**の3点を個別に確認する。
   非商用条項、MAU上限、NOTICE同梱義務、特定地域の除外はいずれも実害が出る。
3. 一部コンポーネントだけ別ライセンスというケースがある（sd-scripts のコアは Apache-2.0 だが、
   使用箇所は個別確認が必要と README にある）。使う部分のライセンスを見る。
4. 迷ったら採用せずホストに確認する。
5. 採用したら、当該ワーカーファイル冒頭の docstring に
   **名称・バージョン・ライセンス・確認日**を明記する（`modal_angle_worker.py` の記法に倣う）。
