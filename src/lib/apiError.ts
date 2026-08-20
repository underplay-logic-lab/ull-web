import "server-only";
import { NextResponse } from "next/server";

// Serializes an unknown thrown/returned error into a plain, JSON-safe shape.
// `Error` (and subclasses like Stripe's StripeError) carry useful fields —
// name, message, and anything a subclass adds (type/code/statusCode/...) —
// as own enumerable properties, so a shallow spread picks them up. Postgrest
// errors are already plain objects ({ message, code, details, hint }) and
// pass through unchanged. `stack` is deliberately omitted from the response
// body (it can leak server file paths) but is still logged server-side.
function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    const { name, message, ...rest } = err as Error & Record<string, unknown>;
    return { name, message, ...rest };
  }
  return err;
}

// Returns { error, step, details } instead of a generic message, so a
// failure at any point in a request is diagnosable from the response alone
// rather than only from server logs.
export function apiErrorResponse(err: unknown, step: string, status: number, logPrefix: string) {
  console.error(`${logPrefix} failed at step "${step}":`, err);

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "object" && err !== null && "message" in err && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : typeof err === "string"
          ? err
          : "Unknown error";

  return NextResponse.json(
    { error: message || "Unknown error", step, details: serializeError(err) },
    { status },
  );
}
