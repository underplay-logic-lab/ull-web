import "server-only";
import type { CinematicWorkflow } from "@/lib/cinematicWorkflow";

export type CinematicGenerateResult = {
  filename: string;
  result_base64: string;
  gpu_tier: string;
  output_path: string;
};

// Posts to WanAnimateBlackwell.custom_workflow on the dedicated Blackwell/B300
// Modal deployment (modal_wan_animate_blackwell.py) — a single-tier
// deployment (no Standard/ULTRA split, unlike modalCustomWorkflow.ts), so
// this intentionally doesn't thread a GpuTier through.
//
// Longer than modalWanAnimate.ts/modalCustomWorkflow.ts's 280s: MiniMax H3's
// BF16 weights (~118GB combined) take measurably longer to cold-load off the
// Volume than Wan Animate 2's — a genuinely cold container was observed
// taking up to ~250s end to end during testing. Keep this in sync with
// maxDuration in /api/generate/cinematic/route.ts (must be >= this).
const MODAL_TIMEOUT_MS = 600_000;

// Still used for anything that wants the old fully-synchronous behavior
// (none of this app's routes do anymore — see spawnCinematicVideoJob below
// — but WanAnimateBlackwell.custom_workflow itself is left as a plain
// synchronous fastapi_endpoint for backward compatibility) — kept as-is,
// untouched by the async job conversion.
export async function generateCinematicVideo(
  workflow: CinematicWorkflow,
  referenceImageName: string,
  referenceImageB64: string,
): Promise<CinematicGenerateResult> {
  const url = process.env.MODAL_CINEMATIC_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!url) {
    throw new Error("Modal is not configured (missing MODAL_CINEMATIC_URL).");
  }
  if (!authToken) {
    throw new Error("Modal is not configured (missing MODAL_AUTH_TOKEN).");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-modal-secret": authToken,
    },
    body: JSON.stringify({
      workflow_json: JSON.stringify(workflow),
      files_b64: { [referenceImageName]: referenceImageB64 },
      save_to_volume: false,
      output_node_id: "92",
    }),
    signal: AbortSignal.timeout(MODAL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal request failed (${res.status}): ${text.slice(0, 2000)}`);
  }

  return (await res.json()) as CinematicGenerateResult;
}

// How long to wait for the *dispatch* request itself to ack — not the
// render. custom_workflow_async is a GPU-less plain Modal function whose
// entire body is an auth check + a .spawn() call, so it should resolve in
// well under a second regardless of whether WanAnimateBlackwell currently
// has a warm B300 container; this timeout only exists to catch a genuinely
// hung/unreachable Modal endpoint, not slow rendering.
const SPAWN_TIMEOUT_MS = 15_000;

export type SpawnCinematicJobParams = {
  jobId: string;
  userId: string;
  creditsCost: number;
  activeJobId: string | null;
  workflow: CinematicWorkflow;
  referenceImageName: string;
  referenceImageB64: string;
};

// Kicks off a Cinematic Video render as a fire-and-forget Modal job instead
// of the old generateCinematicVideo's full request/response cycle — see
// modal_wan_animate_blackwell.py's custom_workflow_async (a GPU-less
// dispatcher — not a method of the GPU-attached WanAnimateBlackwell class,
// specifically so *invoking it* never itself requires Modal to provision a
// GPU container) and run_custom_workflow's job_id-branch (the actual
// spawned work, which PATCHes generation_jobs directly via Supabase REST
// once it finishes). This only throws if the dispatch itself failed — a
// successful call here says nothing about whether the render will
// eventually succeed, only that Modal accepted the job.
export async function spawnCinematicVideoJob(params: SpawnCinematicJobParams): Promise<void> {
  const url = process.env.MODAL_CINEMATIC_ASYNC_URL;
  const authToken = process.env.MODAL_AUTH_TOKEN;
  if (!url) {
    throw new Error("Modal is not configured (missing MODAL_CINEMATIC_ASYNC_URL).");
  }
  if (!authToken) {
    throw new Error("Modal is not configured (missing MODAL_AUTH_TOKEN).");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-modal-secret": authToken,
    },
    body: JSON.stringify({
      workflow_json: JSON.stringify(params.workflow),
      files_b64: { [params.referenceImageName]: params.referenceImageB64 },
      save_to_volume: false,
      output_node_id: "92",
      job_id: params.jobId,
      user_id: params.userId,
      credits_cost: params.creditsCost,
      active_job_id: params.activeJobId,
    }),
    signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Modal dispatch failed (${res.status}): ${text.slice(0, 2000)}`);
  }
}
