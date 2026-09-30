import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { RECHECK_DAYS, nowSec, signToken } from "./license.server";

export type LicenseRow = {
  id: string;
  product: string;
  licensee: string;
  max_devices: number;
  expires_at: string | null;
  revoked_at: string | null;
};

export type IssueResult =
  | { ok: true; token: string; activationId: string }
  | { ok: false; status: number; code: string; error: string };

const fail = (status: number, code: string, error: string): IssueResult => ({ ok: false, status, code, error });

export function licenseUnusable(lic: LicenseRow): IssueResult | null {
  if (lic.revoked_at) return fail(403, "revoked", "このライセンスは停止されています。");
  if (lic.expires_at && new Date(lic.expires_at).getTime() <= Date.now()) {
    return fail(403, "expired", "このライセンスは期限が切れています。");
  }
  return null;
}

/**
 * この PC（hwid）を有効化してトークンを返す。既に有効化済みの PC なら枠を消費せず再発行。
 * 解除済み（revoked）の PC は枠に空きがあれば復活させる。
 */
export async function activateDevice(
  lic: LicenseRow,
  hwid: string,
  method: "online" | "manual",
): Promise<IssueResult> {
  const unusable = licenseUnusable(lic);
  if (unusable) return unusable;

  const { data: acts, error } = await supabaseAdmin
    .from("license_activations")
    .select("id, hwid, revoked_at")
    .eq("license_id", lic.id);
  if (error) return fail(500, "db", error.message);

  const existing = (acts ?? []).find((a) => a.hwid === hwid);
  const activeCount = (acts ?? []).filter((a) => !a.revoked_at).length;
  let activationId: string;

  if (existing && !existing.revoked_at) {
    activationId = existing.id;
    await supabaseAdmin.from("license_activations").update({ last_seen_at: new Date().toISOString() }).eq("id", existing.id);
  } else {
    if (activeCount >= lic.max_devices) {
      return fail(409, "device_limit", `このライセンスで使える PC の台数（${lic.max_devices} 台）に達しています。`);
    }
    if (existing) {
      const { error: upErr } = await supabaseAdmin
        .from("license_activations")
        .update({ revoked_at: null, method, last_seen_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (upErr) return fail(500, "db", upErr.message);
      activationId = existing.id;
    } else {
      const { data: row, error: insErr } = await supabaseAdmin
        .from("license_activations")
        .insert({ license_id: lic.id, hwid, method })
        .select("id")
        .single();
      if (insErr || !row) return fail(500, "db", insErr?.message ?? "insert failed");
      activationId = row.id;
    }
  }

  const iat = nowSec();
  const token = signToken({
    v: 1,
    lid: lic.id,
    aid: activationId,
    product: lic.product,
    licensee: lic.licensee,
    hwid,
    iat,
    exp: lic.expires_at ? Math.floor(new Date(lic.expires_at).getTime() / 1000) : null,
    // 手動発行はオフライン前提なので再確認を求めない（停止は効かない。期限で縛る）。
    rck: method === "online" ? iat + RECHECK_DAYS * 86400 : null,
  });
  return { ok: true, token, activationId };
}
