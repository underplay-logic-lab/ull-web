# モデル ＆ OSS ライセンス判定リスト

CLAUDE.md §5（商用利用・SaaS再頒布・地域制限の3点を満たすものだけ採用する）の判定済みリスト。
**新しいモデル・推論コード・レンダラ・依存ライブラリを採用したら、ここへ追記すること。**

**不可（本番採用禁止）**
- 非商用ライセンス（CC-BY-NC、"research only"、FLUX.1 `[dev]`、**FLUX.1 Kontext `[dev]`** 等）。Kontext は BFL の有償商用ライセンスまたは Pro/Max API 経由でのみ商用可 → 自ホスト採用は不可。
- **YuE2（`m-a-p/YuE2-3B`・2026-09-09 公開）**: 重みは **CC BY-NC 4.0 ＋ 個人クリエイター許可**（`MODEL_LICENSE`、効力 2026-09-16、
  2026-10-04 に GitHub の原文で確認）。許可の対象は *"personal users, content creators and musicians acting in an individual capacity"* で、
  生成した曲の公開・販売・ライセンスは無償で可。ただし *"does not authorize commercial use of the model weights by companies"* →
  **ULL Studio の機能として自ホストするのは不可**（企業は作者に商用ライセンスを申請: lauryliuyang@hkgai.org）。
  事業の宣伝動画の BGM に使うのも「個人として」に当たるか曖昧なので、使うなら同じ窓口に確認してから。
  性能面は声の性別・BPM をスタイル指定で書け、日本語の歌も対応（MiniMax Music 3 の不満点）。コードは Apache-2.0。
- **MiniMax H3（`MiniMaxAI/MiniMax-H3`、MiniMax H3 Community License、2026-10-05 に HF の LICENSE 原文で確認）**: 派生（ファインチューン・マージ・LoRA）可・
  出力は派生扱いではない・出力を他社 AI の学習に使うのは禁止・年商 2,000 万ドル超は要許可・第三者に生成させるなら安全対策の義務・
  地域除外（EU・英国・韓国・米国。**ホストがリスク許容済み**）。**⚠️「商用製品の UI に 'MiniMax H3' を目立つように表示する義務」**があり、
  CLAUDE.md §2（モデル名を出さない）と衝突 → **Director に「Cinematic Director — Powered by MiniMax H3」を常に表示して満たす（2026-10-05 ホスト判断・会員限定にしない）**。
  生成物を公の場に出すときは「機械生成」と明示する義務（Exhibit A 12）。MiniMax の名前を出すのは推奨止まり。
- **MiniMax H3 Fun ControlNet Union（`alibaba-pai/MiniMax-H3-Fun-Controlnet-Union`／`-2.0`、2026-10-08 に HF の README・タグで確認）**: H3 の派生として
  **MiniMax H3 Community License そのもの**＝H3 本体と同じ扱い（地域除外はホストがリスク許容済み・UI 表示は Director の「Powered by MiniMax H3」で満たす）。新たな制約なし。
  ComfyUI は v0.35.0 から対応（`comfy/ldm/minimax/controlnet.py`・model patch 方式）＝本番のピン v0.35.1 のままで使える。
- **10Eros（`TenStrip/10Eros-Max`、Director の土台・Hybrid Beta5）**: MiniMax H3 Community License ＋ 作者の README「LTX 2.3・Wan 2.2・Krea 2 から
  特徴を移植しているので、その部分にはそれぞれのライセンスも及ぶ」。**最も厳しいのは Krea 2 Community License**（商用無料は会社の年商 100 万ドル未満・
  名称／表記／帰属／利用規定／コンテンツフィルタの義務）。LTX 2.x は年商 1,000 万ドル未満なら無料・Wan 2.2 は Apache-2.0。「20 個以上の LoRA のマージ」で
  元 LoRA の出所は不明。NSFW タグ付き。Director で既に本番利用しているので、LoRA 学習の土台にしても新たなリスクは増えない（2026-10-05）。
- **顔入れ替え（`modal_faceswap_worker.py`、2026-10-09）**: Krea 2 Turbo（Krea 2 Community License・上の 10Eros と同じ義務。§4.2 のコンテンツフィルタは
  許可制＋同意の注意書きで対応）・BFS Head Swap v1.1（MIT・有名人／同意のない人に使わない）・comfyui-krea2edit（Apache-2.0）・
  TE `Huihui-Qwen3-VL-4B-Instruct-abliterated`（Apache-2.0。Krea とは別のモデルの差し替えなので §4.1(c) には当たらない）。
  **⚠️ `uzumix/krea2filterbypass3`（ライセンス記載なし・中身は txtfusion.projector の 12 値）**: turbo の抑制を外して咥えている構図の口元を保つ。
  Krea 2 Community License §4.1(c)「security, usage restrictions … を回避・除去しない」に抵触し得る → **ホストがリスク許容（2026-10-09）**。
- **WorldGen（`ZiYang-xie/WorldGen`・Apache-2.0、2026-10-10 確認）**: 画像・文章 → 360 度パノラマ → 3DGS。後半は商用可（奥行き DA-2・Apache-2.0／
  切り分け OneFormer ADE20k・MIT／穴埋め LaMa・Apache-2.0／作者の LoRA `LeoXie/WorldGen`・Apache-2.0）。実験的な ml-sharp（Apple）は使わない。
  **⚠️ パノラマの段が FLUX.1-dev／FLUX.1-Fill-dev（非商用）**。上の「不可」に当たるが、**許可制の限定公開としてホストがリスク許容（2026-10-10）**。
  料金は通常どおり（試してもらう分のクレジットはホストが裏で付与）。一般公開はしない。
- **Qwen-Image 2.1（`Qwen/Qwen-Image-2.1`）**: **Qwen Research License = 非商用のみ**（§2a "FOR NON-COMMERCIAL PURPOSES ONLY"、
  §2b 商用は model-business@notice.qwencloud.com に申請。2026-10-04 に HF の LICENSE 原文で確認）。生成物の商用可否は明記なし →
  宣伝動画の素材にも使わない。**初代 Qwen-Image / Qwen-Image-Edit 2509・2511 は Apache-2.0 で可のまま**（2.1 で変わった）。
  性能は参照画像からの人物の保持が 2511 より明らかに上・1MP 40 step が 18 秒（ローカル int8、2511 は 102 秒）。
- **画風を変える（構図そのまま・2026-10-10）で採用（すべて Apache-2.0・HF の cardData で確認）**: **Qwen-Image-2512**（`Qwen/Qwen-Image-2512`、
  ComfyUI 用は `Comfy-Org/Qwen-Image_ComfyUI` の `qwen_image_2512_bf16`・`qwen_2.5_vl_7b`・`qwen_image_vae`）／
  **Qwen-Image-2512 Fun ControlNet Union**（`alibaba-pai/Qwen-Image-2512-Fun-Controlnet-Union`・2602）／元画像の言語化に **Qwen3-VL 8B**（`Comfy-Org/Qwen3-VL`）。
  2.1（非商用）で手元検証した手順を、商用可のこの組み合わせでやり直して同等以上を確認（`D:\ComfyUI-ull\roomref\restyle2512.py`）。線は ComfyUI 本体の Canny（モデルなし）。
oomref
estyle2512.py`）。線は ComfyUI 本体の Canny（モデルなし）。
oomref
estyle2512.py`）。線は ComfyUI 本体の Canny（モデルなし）。
  奥行きを使うなら Depth Anything V2 は Small だけ（Base・Large は非商用）。
- **`nvdiffrast` / `nvdiffrec`**（NVIDIA Source Code License = 非商用）。3Dレンダリングは商用可のものを使う: 3D Gaussian Splatting 出力を **`gsplat`（Apache-2.0）**、メッシュは PyTorch3D（BSD）/ Kaolin（Apache-2.0）。Inria版3DGSラスタライザ（`diff-gaussian-rasterization`）も研究用途限定で不可。

**可（確認済み・商用OK）**
- **MiniMax Music 3（`MiniMaxAI/MiniMax-Music3`、MiniMax-Music3 Community License、2026-10-02 確認・10-07 に HF の LICENSE 原文で再確認）**:
  商用可・SaaS 可（第三者に生成させるなら規約違反を防ぐ安全対策の義務）・**地域制限なし**・年商 2,000 万ドル超は要許可。
  **⚠️ UI に "MiniMax-Music3" を目立つように表示する義務**（H3 と同じく「Powered by MiniMax-Music3」で満たす・CLAUDE.md §2 の例外）。
  生成物を公の場に出すときは機械生成と明示。ComfyUI 版（DiT・テキスト側・音楽用 VAE `minimax_music3_dav`）も同じ重みの再配布なので同じ扱い。
- **ACE-Step 1.5 XL turbo（曲づくり、`modal_ace_worker.py`）**: 本体 `ACE-Step/acestep-v15-xl-turbo`・言語モデル `acestep-5Hz-lm-0.6B`/`-4B`
  とも **MIT**（2026-10-05 に HF の cardData で確認）。README に「権利処理済みのデータで学習・生成した曲は商用利用可」。
  ComfyUI 用のまとめ直し `Comfy-Org/ace_step_1.5_ComfyUI_files` は Apache-2.0。地域制限・表示義務なし。
- **Demucs `htdemucs`（MIT）／Whisper `openai/whisper-large-v3-turbo`（MIT・リビジョン 41f01f3）**: 曲づくりで「歌詞を歌っているか」の判定に使う
  （声を取り出して聞き取り、歌詞と照合）。2026-10-06 に HF の cardData で確認。生成物には含まれない。
- **ScragVAE（`scragnog/Ace-Step-1.5-ScragVAE`・MIT・rev 0547ba3）**: 曲づくりの VAE（音に戻す部分）。ACE-Step 公式ドキュメント（ALT_VAE.md）が
  差し替え候補として載せるコミュニティ製の調整版。diffusers 形式を ComfyUI 形式に変換して使う（`scripts/ace_scragvae_convert.py`）。2026-10-06 確認。
- **RVC（声の変換・曲の歌声をひなたの声へ。ローカル試験中）**: 本体 `RVC-Project/Retrieval-based-Voice-Conversion-WebUI` **MIT**・
  学習済みの土台（pretrained v2）は VCTK 約 50 時間で学習（VCTK は CC BY 4.0）・特徴抽出 ContentVec（`auspicious3000/contentvec`）**MIT**・
  音程抽出 RMVPE（`Dream-High/RMVPE`）**Apache-2.0**・実行環境 Applio（`IAHispano/Applio`、rev 324f4d8）**MIT**。2026-10-07 に GitHub で確認。
  変換に使う声（ひなた）は架空の人物で権利の心配なし。
- **Fizgig H3 Still（`shootthesound/ComfyUI-Fizgig-H3-Still`・MIT・コミット 10d5171）**: Photo Director の 1 コマ静止画用 ComfyUI ノード 2 つ
  （`modal_wan_animate_blackwell.py` の image に同梱）。モデルを含まないコードだけ。2026-10-06 確認。
- **Wan2.1-VACE-1.3B（`Wan-AI/Wan2.1-VACE-1.3B`）**: Apache-2.0（2026-10-06 に HF の cardData で確認）。動画→アニメのローカル試作だけ（不採用・本番未使用）。
- **Qwen-Image / Qwen-Image-Edit-2511**: Apache-2.0。現行の画像編集・リスタイルの基盤。
- **Microsoft TRELLIS / TRELLIS.2（`microsoft/TRELLIS.2-4B`）**: MIT。image→3D の第一候補（非商用レンダラ依存は上記のとおり回避）。
- **Qwen3.8-27B-abliterated（`hotdogs/Qwen3.8-27B-abliterated`、base `Qwen/Qwen3.8-27B`）**: Apache-2.0（モデルカードの
  メタデータで 2026-09-24 確認）。LoRA の学習前キャプション・Director Advanced の台本・キャプション解析（`modal_caption_worker.py`）で使用。
- **vLLM 0.30.0**: Apache-2.0。推論エンジン（`modal_caption_worker.py`）。
- **WD タガー（`SmilingWolf/wd-eva02-large-tagger-v3`）**: Apache-2.0（2026-09-25 確認）。LoRA Studio の構図診断（`modal_wd_tagger.py`・CPU/onnxruntime〔MIT〕）。
- **Qwen2.5-VL-7B-Instruct（abliterated 版を含む）**: Apache-2.0。※ Qwen2.5-VL の **3B は研究用ライセンス（商用不可）**、72B は Qwen ライセンス。
- **MediaPipe 1.0.1 ＋ 顔検出 BlazeFace short range・Pose Landmarker heavy**: いずれも Apache-2.0（2026-10-02 確認）。
- **Depth Anything V2 Small（`depth-anything/Depth-Anything-V2-Small-hf`）**: Apache-2.0（2026-10-02 確認）。**Base・Large は CC-BY-NC（非商用）なので不可**。Multi-Angle の後ろ斜めの作り直し（`_depth_map`）。
  Multi-Angle の向きの自動判定（`modal_angle_worker.py` の `_face_side`・CPU）。
- **Wan2.2-S2V-14B**: Apache-2.0・地域制限なし。ただし**速度・品質とも本番採用の水準に届かず不採用**（`docs/gpu-benchmarks.md` §10）。

**要注意（copyleft・表示義務あり・採用可だが実務対応が必要）**
- **Illustrious XL 系全般（`OnomaAIResearch/Illustrious-xl-early-release-v0` と、その派生の
  WAI-NSFW-illustrious-SDXL 等のマージモデル）**: **Fair AI Public License 1.0-SD
  （faipl-1.0-sd）**。2026-09-21 確認。
  - **商用利用は可**（商用を禁じる条項が無い。Prohibited Uses に触れない限り）。
  - ⚠️ **「modify」の定義に "学習" が含まれる** — 原文:
    *"To 'modify' also means to perform any training on a model or to combine a model
    with another model."* つまり **このベースで LoRA を焼く行為そのものが改変**であり、
    **出来上がった LoRA は FAIPL-1.0-SD（または同等以上に寛容なライセンス）で提供する
    義務がある**。
  - ⚠️ **ネットワーク越しに提供する場合の義務**: *"If you modify this software and allow
    users to interact with it through a computer network, you must ensure they have a
    reasonable way to receive the corresponding source code from you."* ただし
    *"if you are only allowing users to interact with a derived model, then you may
    choose to provide a download link or written offer only for the derived model."*
    → **ULL Studio は学習した LoRA 本体をユーザーにダウンロードさせているので、この点は
    実質満たしている。** 足りないのは「その LoRA が FAIPL-1.0-SD 下にある」という表示。
  - Prohibited Uses は OpenRAIL 系の標準的な制限リスト（違法用途・未成年への害・虚偽情報・
    個人識別情報の悪用・嫌がらせ・差別・医療アドバイス・司法/執行/移民手続 等）。
    違反通知から **30日以内に是正すればライセンスを維持できる** Excuse 条項あり。
  - ✅ **Outputs 条項で「生成した画像」は対象外**:
    *"The output of this software is not covered by this license, and no contributor
    claims any rights to it."* → **画像は自由。**ただし LoRA は上記のとおり
    「output」ではなく「derived model」なので、こちらは別。混同しないこと。
  - ✅ **実務対応（2026-09-21 実施済み・3層）**:
    1. 利用規約 **第3条の2**（`src/app/terms/page.tsx`）— サービスとしての告知
    2. **.safetensors の metadata に焼き込み**（`modelspec.license` /
       `ss_ull_license` / `ss_ull_license_url` / `ss_ull_base_model`）—
       Civitai や ComfyUI へ持ち出されても付いて回る
    3. **LICENSE.txt をジョブフォルダに同梱** — 一括DL の ZIP に入る
    実装は `modal_sdxl_lora_worker.py` の `_PRESET_LICENSE` /
    `_stamp_license_metadata` / `_write_license_file`。対象は
    `illustrious_xl` と `wai_illustrious` のみ（ここに無い preset には何も
    焼き込まない — 誤った表示を付ける方が害が大きい）。
    ⚠️ 焼き込むのは**最終チェックポイントのみ**。中間チェックポイントは
    LICENSE.txt が同じフォルダにあることでカバーする。
  - ⚠️ **版ごとに確認すること**: WAI 系は Civitai 配布で、成人向けのため現在は civitai.red
    側にページが移っている（通常の Civitai URL からはライセンス欄が読めない）。
    HF ミラー（`John6666/wai-nsfw-illustrious-v10-sdxl`）は
    `license_name: faipl-1.0-sd` を明示しているが、**採用する版そのもののモデルページで
    再確認**すること。
- **Juggernaut XL v9（`RunDiffusion/Juggernaut-XL-v9`）**: SDXL 系。上記とは別ライセンス
  （CreativeML Open RAIL++-M 系）。**未精査** — 採用済みだが条文確認がまだ。

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
