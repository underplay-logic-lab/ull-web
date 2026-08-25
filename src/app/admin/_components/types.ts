export type { StudioCustomWorkflow, WorkflowInputField, WorkflowInputFieldType } from "@/lib/customWorkflows";
export type { SiteContentRow } from "@/lib/siteContents";

export type StudioPreset = {
  id: string;
  title: string;
  category: string;
  video_url: string;
  thumbnail_url: string | null;
  priority: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type StudioPricing = {
  key: string;
  label: string;
  credits: number;
  unit_cost_usd: number;
  description: string | null;
  updated_at: string;
};

export type GenerationLog = {
  id: string;
  user_id: string;
  user_email: string | null;
  job_type: string;
  prompt_input: string | null;
  output_file_name: string | null;
  execution_time_ms: number | null;
  credits_consumed: number | null;
  status: "success" | "failed";
  error_message: string | null;
  created_at: string;
};

export type LogsSummary = {
  totalCount: number;
  successRate: number;
  totalCreditsConsumed: number;
  totalModalCostUsd: number;
  scanLimited: boolean;
};

export type VolumeFile = {
  path: string;
  size_bytes: number;
  modified_at: string;
};

export type ModelDownload = {
  id: string;
  url: string;
  save_path: string;
  status: "pending" | "downloading" | "completed" | "failed";
  progress_percent: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ModalLogEntry = {
  ts: number;
  gpu_tier: "standard" | "ultra";
  status: "success" | "failed";
  duration_s: number;
  filename: string | null;
  error: string | null;
};

export type GpuTierStatus = {
  name: string;
  vramGb: number;
  runningJobs: number;
};

export type ActiveJob = {
  id: string;
  user_id: string;
  user_email: string | null;
  job_type: string;
  gpu_tier: "standard" | "ultra";
  started_at: string;
};

export type ModalLogsResponse = {
  gpuStatus: { standard: GpuTierStatus; ultra: GpuTierStatus };
  activeJobs: ActiveJob[];
  comfyLogs: ModalLogEntry[];
  comfyLogsUnavailable: boolean;
};
