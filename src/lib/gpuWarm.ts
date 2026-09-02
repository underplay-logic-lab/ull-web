// Shared constants for the 🔥 火入れ (GPU warm-extend) system — used by both
// the client-side Studio badge and the /api/gpu/warm-extend route. No
// "server-only" guard: imported from a client component.

// How many seconds one "🔥 火をくべる" click (and a successful generation's
// free auto-extend) adds to gpu_warm_status.warm_until.
//
// Kept in lock-step with the Modal `scaledown_window` (30s Keep-Warm 規格,
// CLAUDE.md §1) so the countdown reflects how long the GPU container is
// actually kept warm — a longer value here would show "warm" after the
// container has already scaled down and cause a surprise cold start.
export const WARM_EXTEND_SECONDS = 30;

// Credits consumed per click.
export const WARM_EXTEND_COST = 1;
