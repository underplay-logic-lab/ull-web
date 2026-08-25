// Shared constants for the 🔥 火入れ (GPU warm-extend) system — used by both
// the client-side Studio badge and the /api/gpu/warm-extend route. No
// "server-only" guard: imported from a client component.

// How many seconds one "🔥 火をくべる" click adds to gpu_warm_status.warm_until.
export const WARM_EXTEND_SECONDS = 60;

// Credits consumed per click.
export const WARM_EXTEND_COST = 1;
