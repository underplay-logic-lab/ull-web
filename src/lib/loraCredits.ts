// Step-count constants for the LoRA Studio.
//
// Pricing itself moved to src/lib/loraPricing.ts (multi-dimensional:
// model / resolution / batch / rank multipliers). This file now only holds
// the shared step-count anchors the UI slider and the server-side defaults
// still need.

// Runs that don't expose a steps control (完全オート / セミオート) use the
// worker's built-in default, so the price matches what actually runs.
export const DEFAULT_LORA_STEPS = 2000;

// Top of the steps slider (エキスパート mode).
export const LORA_MAX_STEPS = 5000;
