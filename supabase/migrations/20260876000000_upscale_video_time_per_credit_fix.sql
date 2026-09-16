-- 緊急修正（2026-09-17）: 動画超解像の課金式修正（904C→51C等、フレーム数
-- 完全比例から固定費+わずかな比例分へ）に伴い、これを媒介にした
-- max_allowed_time（原価割れ損切りウォッチドッグの許容秒数 = 消費C ×
-- upscale_video_time_per_credit_s + コールドスタート猶予）も連動して
-- 激減し、正常進行中のHDジョブ（実測10分弱）が「処理時間の上限を超え
-- ました」で誤って強制終了・返金される実機事故が発生した。
--
-- ホスト判断（2026-09-17）: 仕組み自体は残す（TRELLIS workerクラッシュ
-- ループで31分無駄になった教訓があるため、本当の暴走を止める必要はある）が、
-- かなり大きく緩める。upscale_video_time_per_credit_s を 6 → 45 へ引き上げ、
-- HD最小ケース（28C）で25分の猶予（実測10分超に対し2.5倍以上のマージン）、
-- 他プリセットはさらに大きな余裕（92〜445分）を確保する。
-- コード側SSOT（knobDefaults.ts）は同時に更新済み。

update public.pricing_knobs
set value = 45,
    updated_at = now()
where key = 'upscale_video_time_per_credit_s';
