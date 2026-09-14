-- lora_datasets バケットの file_size_limit が 50MB のままだった（バケット作成時の
-- 既定値が見直されていなかった）。フロント（LoraStudioTab.tsx）は1枚あたり最大
-- 96MB（MAX_FILE_BYTES、約6KのPNG想定）を受け付けると案内しているが、実際には
-- 50MBを超えるとSupabase Storageが413 (EntityTooLarge) を返し、案内と実態が
-- 食い違っていた（2026-09-15、LoRA学習データセット上限の調査中に発見）。
-- 同一プロジェクトの upscale-results (300MB) / upscale-uploads (500MB) は
-- 既にこれより遥かに大きい値で運用できているため、プロジェクト側の上限では
-- なく単なる見直し漏れと判断し、150MBへ引き上げる（96MBのアプリ側上限に
-- 余裕を持たせた値）。
update storage.buckets
set file_size_limit = 157286400 -- 150 MB
where id = 'lora_datasets';
