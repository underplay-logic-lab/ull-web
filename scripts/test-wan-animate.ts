// One-off test script for the RunPod Serverless "Wan 2.1 Animate" endpoint.
// Submits the Wan Animate 2 ComfyUI workflow with a reference image + pose
// video, polls until the job completes, and saves the resulting MP4.
//
// Usage: npx tsx scripts/test-wan-animate.ts
//
// Reads RUNPOD_API_KEY from .env.local (not committed). The workflow JSON
// and the two input files it references are local paths, overridable via
// env vars for anyone re-running this against different assets:
//   WAN_WORKFLOW_PATH, WAN_REFERENCE_IMAGE_PATH, WAN_POSE_VIDEO_PATH

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// --- .env.local (no dotenv dependency for a one-off script) ---
const envPath = path.resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].trim();
    }
  }
}

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
if (!RUNPOD_API_KEY) {
  throw new Error("RUNPOD_API_KEY is not set (expected in .env.local).");
}

const ENDPOINT_ID = "axwi3e70n9wqgh";
const BASE_URL = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;

const WORKFLOW_PATH =
  process.env.WAN_WORKFLOW_PATH || "C:/Users/t-num/Downloads/wan_animate2.json";

// These filenames must match the "image"/"file" values the workflow's
// LoadImage/LoadVideo nodes reference — the worker writes each entry in
// input.images to ComfyUI's input/ directory under exactly this name.
const REFERENCE_IMAGE_NAME = "260811_00002_lu.png";
const REFERENCE_IMAGE_PATH =
  process.env.WAN_REFERENCE_IMAGE_PATH ||
  "D:/ComfyUI/ComfyUI_windows_portable/ComfyUI/input/260811_00002_lu.png";

const POSE_VIDEO_NAME = "この画像を元に動画を作成して。アニメーション風にして、ストー.mp4";
const POSE_VIDEO_PATH =
  process.env.WAN_POSE_VIDEO_PATH ||
  "D:/ComfyUI/ComfyUI_windows_portable/ComfyUI/input/" + POSE_VIDEO_NAME;

const OUTPUT_PATH = path.resolve(process.cwd(), "output_wan_animate.mp4");
const POLL_INTERVAL_MS = 5000;
const MAX_POLL_MINUTES = 20;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadBase64(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }
  return readFileSync(filePath).toString("base64");
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(2)} ${units[i]}`;
}

type RunpodResponse = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string;
  executionTime?: number;
  delayTime?: number;
};

async function runpodFetch(pathSuffix: string, init?: RequestInit): Promise<RunpodResponse> {
  const res = await fetch(`${BASE_URL}${pathSuffix}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RUNPOD_API_KEY}`,
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let data: RunpodResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`RunPod ${pathSuffix} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 500)}`);
  }

  if (!res.ok) {
    throw new Error(`RunPod ${pathSuffix} failed (HTTP ${res.status}): ${JSON.stringify(data)}`);
  }

  return data;
}

// worker-comfyui's completed output shape varies by what the workflow's
// save node produced — check the common places a base64 video could land.
function extractVideoBase64(output: unknown): string {
  const asRecord = (v: unknown) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null);
  const record = asRecord(output);
  if (!record) {
    throw new Error(`Unrecognized RunPod output shape: ${JSON.stringify(output).slice(0, 500)}`);
  }

  for (const key of ["images", "videos", "files"]) {
    const arr = record[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const first = asRecord(arr[0]);
      if (first && typeof first.data === "string") return first.data;
    }
  }

  if (typeof record.video === "string") return record.video;
  if (typeof record.message === "string") return record.message;

  throw new Error(`Could not find video data in RunPod output: ${JSON.stringify(output).slice(0, 500)}`);
}

async function main() {
  console.log(`[test-wan-animate] endpoint: ${ENDPOINT_ID}`);
  console.log(`[test-wan-animate] workflow: ${WORKFLOW_PATH}`);
  console.log(`[test-wan-animate] reference image: ${REFERENCE_IMAGE_PATH}`);
  console.log(`[test-wan-animate] pose video: ${POSE_VIDEO_PATH}`);

  const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, "utf8"));
  const referenceImageB64 = loadBase64(REFERENCE_IMAGE_PATH);
  const poseVideoB64 = loadBase64(POSE_VIDEO_PATH);

  console.log(
    `[test-wan-animate] payload sizes: image=${formatBytes(referenceImageB64.length)} (base64), ` +
      `video=${formatBytes(poseVideoB64.length)} (base64)`,
  );

  const payload = {
    input: {
      workflow,
      images: [
        { name: REFERENCE_IMAGE_NAME, image: referenceImageB64 },
        { name: POSE_VIDEO_NAME, image: poseVideoB64 },
      ],
    },
  };

  const startedAt = Date.now();

  console.log("[test-wan-animate] submitting job to /run ...");
  let job = await runpodFetch("/run", { method: "POST", body: JSON.stringify(payload) });

  if (!job.id) {
    throw new Error(`RunPod /run did not return a job id: ${JSON.stringify(job)}`);
  }

  console.log(`[test-wan-animate] job id: ${job.id}`);
  console.log(`[test-wan-animate] initial status: ${job.status}`);

  const deadline = startedAt + MAX_POLL_MINUTES * 60 * 1000;

  while (job.status === "IN_QUEUE" || job.status === "IN_PROGRESS") {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${MAX_POLL_MINUTES} minutes waiting for job ${job.id}.`);
    }

    await sleep(POLL_INTERVAL_MS);
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    job = await runpodFetch(`/status/${job.id}`);
    console.log(`[test-wan-animate] [+${elapsedSec}s] status: ${job.status}`);
  }

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(`[test-wan-animate] final status: ${job.status} (wall time: ${totalSec.toFixed(1)}s)`);

  if (typeof job.delayTime === "number") {
    console.log(`[test-wan-animate] queue delay (RunPod-reported): ${(job.delayTime / 1000).toFixed(1)}s`);
  }
  if (typeof job.executionTime === "number") {
    console.log(`[test-wan-animate] GPU execution time (RunPod-reported): ${(job.executionTime / 1000).toFixed(1)}s`);
  }

  if (job.status !== "COMPLETED") {
    console.error(`[test-wan-animate] job did not complete. Full response:`);
    console.error(JSON.stringify(job, null, 2));
    process.exitCode = 1;
    return;
  }

  const videoBase64 = extractVideoBase64(job.output);
  const videoBuffer = Buffer.from(videoBase64, "base64");
  writeFileSync(OUTPUT_PATH, videoBuffer);

  console.log(`[test-wan-animate] saved output video -> ${OUTPUT_PATH} (${formatBytes(videoBuffer.length)})`);
  console.log(`[test-wan-animate] job id: ${job.id}`);
  console.log(`[test-wan-animate] total wall time: ${totalSec.toFixed(1)}s`);
}

main().catch((err) => {
  console.error("[test-wan-animate] FAILED:", err);
  process.exitCode = 1;
});
