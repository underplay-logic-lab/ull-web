# 説明動画の台本（2026-10-07〜）

撮り方は `promo/README.md`（record.mjs → F8 でテロップのメモ → Remotion 4K → YouTube → `src/lib/tutorialVideos.ts`）。
順番と進み具合は `docs/STATUS.md` の「説明動画を撮りながら進める」。1 本＝1 タブ。待ち時間は編集で自動的に早送りになるので、待つ間は何もしなくてよい。
テロップは **F8 → メモ → Enter**（下の「F8」の行をそのまま入れれば、編集でそのまま使える）。金額はテロップに書かない（変わり得るため）。

---

## 1. 曲づくり（録画名 `hinata-song1`）

### ねらい（アピール）
- 思いつきを 1 行書くだけで、**歌入りの曲が何曲もまとめてできる**（3〜10 曲。気に入った 1 曲を選ぶ）。
- **自分の歌詞でも作れる**。日本語の歌がちゃんと歌われる。
- 声が入らなかった曲は**自動で作り直す**（失敗作を引かない）。
- できた曲の**サビを切り出して、そのまま歌う動画（Cinematic Director）へ渡せる** ← 次の回へつなぐ。

### 撮る前の準備
- テスト用アカウントのクレジットが足りているか（3 曲 × 2 回＋次の回の動画分）。
- 下の「思いつき」と「歌詞」をメモ帳に用意しておく（録画中に考え込むと間延びする）。
- 長さは **「1 番だけ」**（待ち時間が短い・Director に渡すのは 68 秒まで）。曲数は **3 曲**（多いほど待つ）。

### 流れ

**パート A: 思いつきから（メイン）**
1. タブを開いた状態から始める（上の説明文が映る）。
   - F8: `思いつきを書くだけで、歌入りの曲をまとめて作れます`
2. 「思いつきから」を選んだまま、「どんな曲？」に入力:
   > 朝の光が差し込む部屋で、新しい一日を楽しみに、やさしく前向きに歌う曲。聴いた人がちょっと笑顔になれるように。
   - F8: `場面・気持ち・誰に向けた歌かを書くと、歌詞にしやすくなります`
3. 「曲調（任意）」に入力:
   > 明るい J-POP、アコースティックギター、やさしいピアノ、朝
4. 声＝**女性ボーカル**、曲数＝**3 曲**、長さ＝**1 番だけ**。
   - F8: `同じ思いつきから少しずつ違う曲を作るので、気に入った 1 曲を選べます`
5. 「3 曲つくる」を押す。
   - F8: `画面を閉じても作曲は続きます（待ち時間は早送り）`
6. できたら 1 曲目を 10 秒ほど再生 → 2 曲目も少し再生（違いが分かる程度）。
   - F8: `同じ指示でも、曲ごとにメロディや雰囲気が変わります`
7. 「歌詞を見る」を開いて、AI が書いた歌詞をスクロールで見せる。
   - F8: `歌詞は AI が書きます`

**パート B: 歌詞を書く**
8. 「歌詞を書く」に切り替え、下の歌詞を貼る（行数から長さが自動で決まるのを見せる）。
   - F8: `自分の歌詞でも作れます。[Verse] と [Chorus] を分けると、まとまった曲になります`
9. 曲調は A と同じ、声・曲数も同じで「3 曲つくる」。
10. できたら 1 曲を再生し、**歌詞どおりに歌っている**ところ（サビ）を聞かせる。
    - F8: `日本語の歌詞をそのまま歌います`

**パート C: 次の回へつなぐ（Director へ）**
11. 一番気に入った曲の「一部を動画の音声に」を押し、サビの開始秒と長さ（20〜30 秒くらい）を入れる。
    - F8: `サビなどを切り出して、歌う動画の音声にできます`
12. 「この範囲を Director へ渡す」→ Cinematic Director のタブに切り替わり、音声が入っているところを映して**ブラウザを閉じる**（Director の操作は次の回で撮る）。
    - F8: `次の動画では、この曲で歌う動画を作ります`

### パート B に貼る歌詞（オリジナル・10 行＝1 番）

```
[Verse]
まどをあけたら ひかりのなか
ねぐせのままで わらってみた
きのうのことは もうわすれて
きょうのわたしに あいにいこう

[Chorus]
おはよう あたらしい あさ
ちいさな ゆめを ポケットに
おはよう あなたにも とどけ
こころが はれる うたを
```

（ひらがな中心＝読み間違えが起きにくい。1 行は短め。）

### 録画の後（Claude がやる）
- `edit.json` の `title`（例: 「曲づくり — 思いつきから歌入りの曲を」）・テロップの文面を整える → 4K で書き出し → 確認版を渡す。
- YouTube 投稿一式を出す（全回共通）: 4K 動画のパス・サムネイル（`node brand/thumbnail.mjs`）・タイトル・説明欄（チャプター込み。
  時刻は edit.json のテロップを `toOutput(buildSegments(...))` で書き出し後の秒へ）・タグ・投稿設定（AI の使用＝はい・埋め込み許可）。
  **次の回へのリンクは説明欄に書かない**（再生リストで回す。2026-10-08 ホスト）。
- 済（2026-10-08）: 曲づくり＝ https://youtu.be/PDD-UU6L75I （5:00・`src/lib/tutorialVideos.ts` の `song`）。
- 選んだ曲（何回目の何曲目か・切り出した秒）を STATUS に残す（次の回の素材）。

---

## 2. Cinematic Director — ひなたの曲で 68 秒の一発撮り（録画名 `hinata-director2`）

### ねらい（アピール）
- **曲を 1 本持ち込むだけで、その曲を歌う 68 秒の動画が一発で**できる（カット無しの長回し・口が歌に合う）。
- **写真 9 枚で同じ人物のまま**（表情・全身・後ろ姿を渡すと、振り向いても歩いても崩れない）。
- 4K にする前提なら **Quality**（画質モードの下の案内文どおり）。

### 同時に確かめること（試験を兼ねる・2026-10-08 ホストと決定）
- **台本が 68 秒の最後まで守られるか**: 下のプロンプトの「確かめる動き」10 個を、できた動画で 1 つずつ見る（後半ほど崩れるか）。
  後半が崩れるなら「区切りごとに作ってつなぐ（MV モード）」を作る根拠にする。
- **LoRA なし×Quality で口がどれだけ動くか**（これまでの「Quality でも口が戻らない」は LoRA ありの結果）。
- 結果が悪い区間が出ても、次の回（3. 動画の部分修正）の素材になる。

### 撮る前の準備
- 参照 9 枚: `promo/public/refs/hinata/director/01〜09`（Gemini 製・01 が正面の顔・05〜07 が口を開けた表情・08 全身・09 後ろ姿）。
- 曲: `D:/ComfyUI-ull/results/ace_local/master/hinata68_master.wav`（68.0 秒・歌は 3.5〜62.5 秒・128 BPM で 15 秒ずつ
  1 番 A メロ 3.5〜18.5／サビ 18.5〜33.5／2 番 A メロ 33.5〜48／サビ 48〜62.5／後奏 62.5〜68）。
- 下のプロンプトをメモ帳に用意（録画中に打たない・貼るだけ）。
- テスト用アカウントのクレジット: 約 2,470C（Quality 27.5C×68 秒＝1,870C＋参照 8 枚で 4%×8＝+600C）。

### 流れ
1. Cinematic Director のタブを開いた状態から。
   - F8: `曲と写真から、その曲を歌う動画を作ります`
2. 「顔写真として使う」（参照モード）に切り替え、01〜09 をまとめてドロップ。役目はすべて「同じ人物」（既定のまま）。
   - F8: `同じ人物の写真を何枚も渡すと、表情や角度が変わっても同じ人のままになります`
3. 音声の欄に曲（hinata68_master.wav）をドロップ。長さ 68 秒が表示されるところを映す。
   - F8: `歌を入れると、動画の長さは曲に合わせて決まります`
4. 縦横比 16:9、画質モード **Quality**。画質モードの下の案内文を映す。
   - F8: `あとで 4K にするなら Quality がおすすめです`
5. 台本は「直接書く（上級者向け）」に切り替えて、下のプロンプトを貼る。
   - F8: `何秒ごろに何をするかまで書けます（ここでは上級者向けの「直接書く」）`
6. 生成 → ブラウザを閉じてよい（待ち時間は早送り）。
   - F8: `画面を閉じても作業は続きます（待ち時間は早送り）`
7. 完成したら最初から最後まで再生（**早送りしない**＝edit.json の realtime。音は後から重ねる＝sounds に結果の動画の音声）。
   - F8: `カット無しの長回しで、最後まで同じ人物のまま歌います`

### 貼るプロンプト（直接書く・英語）
```
One continuous unbroken take filmed with a single moving camera: no cuts, no edits, no scene changes, no transitions from the first frame to the last, about 68 seconds long. The soundtrack (music and/or voice) is given and must not change; the character's lips move exactly in sync with the vocals and stay closed when there are no vocals.
The person from <Picture 1> (same face, black bob haircut, plain white T-shirt, blue jeans and white sneakers as in <Picture 8>) is in a bright, sunny apartment room in the morning, with a large window, sheer white curtains moving in the breeze and soft sunlight.
At the start she stands at the window with her back to the camera, looking outside, exactly as in <Picture 9>; the camera is at full-body distance behind her.
Around 4 seconds, as the singing begins, she turns around to face the camera with a small smile and starts singing.
Around 10 seconds, the same camera slowly pushes in from full body to a waist-up framing while she keeps singing to the camera.
Around 19 seconds, when the chorus starts, her smile becomes bright and open, and she raises her right hand up toward the sunlight from the window.
Around 26 seconds, continuing without any cut, she walks slowly toward the camera while singing, and the camera gently moves backward to keep her waist-up.
Around 34 seconds, she sits down on the edge of a bed with white sheets and sings softly, looking slightly down, both hands resting on her knees.
Around 41 seconds, the camera glides around to her left side, showing her profile as she sings.
Around 48 seconds, at the second chorus, she stands up, laughs, and spins around once in place.
Around 55 seconds, she opens both arms wide toward the camera, singing with her whole body, eyes closed for a moment.
Around 63 seconds, the singing ends: her lips close, she turns her face toward the window and smiles, and the camera slowly pulls back to full body as the music fades.
```

### 確かめる動き（できた動画で 1 つずつ見る）
| 秒 | 動き | 見方 |
|---|---|---|
| 0 | 窓の前で後ろ姿 | 背中から始まるか |
| 4 | 振り向いて歌い出す | 歌い出しと口が合うか |
| 10 | 全身→腰から上へ寄る | 画角が変わるか |
| 19 | サビで笑顔・右手を窓の光へ | 手が上がるか（左右も） |
| 26 | カメラへ歩いてくる | 歩くか・カメラが下がるか |
| 34 | ベッドの端に座る・手は膝 | 座るか |
| 41 | 左側へ回り込み横顔 | 横顔になるか |
| 48 | 立って笑ってその場で 1 回転 | 回るか・回った後も同じ顔か |
| 55 | 両腕を広げ目を一瞬閉じる | 腕が開くか |
| 63 | 口を閉じ窓を見て微笑む・引いて全身 | 歌が終わったら口が止まるか |
あわせて: カットの数（ffmpeg scdet）・口の動き（口の開きの 1 秒ごとの標準偏差×100。LoRA 1.0 は 1.61・参照 9 枚は 2.52〜2.99）。

### 録画の後（Claude がやる）
- テロップ・realtime・sounds を edit.json に → 4K 書き出し → 確認版 → **YouTube 投稿一式**（1 番の「録画の後」と同じ）。
- 上の表を埋めて STATUS に（後半ほど崩れるか → MV モードの判断材料）。
