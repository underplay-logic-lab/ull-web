import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { HARD_CHECK_DAYS, RECHECK_DAYS, TRANSFER_COOLDOWN_DAYS, nowSec, signToken } from "./license.server";
import { licenseTrialDays } from "./products";

export type LicenseRow = {
  id: string;
  product: string;
  licensee: string;
  max_devices: number;
  expires_at: string | null;
  revoked_at: string | null;
  last_transfer_at?: string | null;
};

export type IssueResult =
  | { ok: true; token: string; activationId: string }
  | { ok: false; status: number; code: string; error: string; transferAvailable?: boolean };

const fail = (status: number, code: string, error: string, extra: Partial<IssueResult> = {}): IssueResult =>
  ({ ok: false, status, code, error, ...extra }) as IssueResult;

const DAY = 86400;

export function licenseUnusable(lic: LicenseRow): IssueResult | null {
  if (lic.revoked_at) return fail(403, "revoked", "このライセンスは停止されています。");
  if (lic.expires_at && new Date(lic.expires_at).getTime() <= Date.now()) {
    return fail(403, "expired", "このライセンスは期限が切れています。");
  }
  return null;
}

function transferCooldownEnds(lic: LicenseRow): Date | null {
  if (!lic.last_transfer_at) return null;
  const ends = new Date(new Date(lic.last_transfer_at).getTime() + TRANSFER_COOLDOWN_DAYS * DAY * 1000);
  return ends.getTime() > Date.now() ? ends : null;
}

/**
 * この PC（hwid）を有効化してトークンを返す。既に有効化済みの PC なら枠を消費せず再発行。
 * 解除済み（revoked）の PC は枠に空きがあれば復活させる。
 * 台数が上限のとき: transfer=true なら、最後に確認が来たのが一番古いオンライン認証の PC を外して移す（30 日に 1 回）。
 */
export async function activateDevice(
  lic: LicenseRow,
  hwid: string,
  method: "online" | "manual",
  opts: { transfer?: boolean } = {},
): Promise<IssueResult> {
  const unusable = licenseUnusable(lic);
  if (unusable) return unusable;

  const { data: acts, error } = await supabaseAdmin
    .from("license_activations")
    .select("id, hwid, method, last_seen_at, revoked_at")
    .eq("license_id", lic.id);
  if (error) return fail(500, "db", error.message);

  const existing = (acts ?? []).find((a) => a.hwid === hwid);
  const active = (acts ?? []).filter((a) => !a.revoked_at);
  let activationId: string;

  if (existing && !existing.revoked_at) {
    activationId = existing.id;
    await supabaseAdmin.from("license_activations").update({ last_seen_at: new Date().toISOString() }).eq("id", existing.id);
  } else {
    if (active.length >= lic.max_devices) {
      // 手動発行（再確認しない）の PC は外しても止められないので、自分での移し替えの対象にしない。
      const movable = active
        .filter((a) => a.method === "online")
        .sort((a, b) => a.last_seen_at.localeCompare(b.last_seen_at));
      const cooldown = transferCooldownEnds(lic);
      const transferAvailable = method === "online" && movable.length > 0 && !cooldown;
      if (!opts.transfer || !transferAvailable) {
        const why = cooldown
          ? `PC の移し替えは ${TRANSFER_COOLDOWN_DAYS} 日に 1 回までです（次は ${cooldown.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })} から）。`
          : "";
        return fail(
          409,
          "device_limit",
          `このライセンスで使える PC の台数（${lic.max_devices} 台）に達しています。${why}` +
            (transferAvailable ? "" : "PC を買い替えた場合は「困ったときは」からご連絡ください。古い PC の登録を外します。"),
          { transferAvailable },
        );
      }
      const victim = movable[0];
      const now = new Date().toISOString();
      const { error: revErr } = await supabaseAdmin.from("license_activations").update({ revoked_at: now }).eq("id", victim.id);
      if (revErr) return fail(500, "db", revErr.message);
      await supabaseAdmin.from("licenses").update({ last_transfer_at: now }).eq("id", lic.id);
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
  const online = method === "online";
  const token = signToken({
    v: 1,
    kind: "license",
    lid: lic.id,
    aid: activationId,
    product: lic.product,
    licensee: lic.licensee,
    hwid,
    iat,
    exp: lic.expires_at ? Math.floor(new Date(lic.expires_at).getTime() / 1000) : null,
    // 手動発行は非常用（通信が止められる環境など）なので再確認を求めない。停止は効かないので期限で縛る。
    rck: online ? iat + RECHECK_DAYS * DAY : null,
    hck: online ? iat + HARD_CHECK_DAYS * DAY : null,
  });
  return { ok: true, token, activationId };
}

/** 試用（キー無し）。ツール × PC ごとに 1 回。期限内なら同じ期限で再発行する（フォルダを入れ直した等）。 */
export async function issueTrial(product: string, hwid: string, opts: { start: boolean }): Promise<IssueResult> {
  const days = licenseTrialDays(product);
  if (days <= 0) return fail(404, "no_trial", "このツールには試用期間がありません。");

  const { data: row, error } = await supabaseAdmin
    .from("license_trials")
    .select("id, expires_at")
    .eq("product", product)
    .eq("hwid", hwid)
    .maybeSingle();
  if (error) return fail(500, "db", error.message);

  let trial = row;
  if (!trial) {
    if (!opts.start) return fail(404, "not_found", "試用の記録が見つかりませんでした。");
    const expires = new Date(Date.now() + days * DAY * 1000).toISOString();
    const { data: ins, error: insErr } = await supabaseAdmin
      .from("license_trials")
      .insert({ product, hwid, expires_at: expires })
      .select("id, expires_at")
      .single();
    if (insErr || !ins) return fail(500, "db", insErr?.message ?? "insert failed");
    trial = ins;
  } else {
    await supabaseAdmin.from("license_trials").update({ last_seen_at: new Date().toISOString() }).eq("id", trial.id);
  }

  const exp = Math.floor(new Date(trial.expires_at).getTime() / 1000);
  if (exp <= nowSec()) {
    return fail(
      403,
      "trial_expired",
      "試用期間が終わりました。続けて使いたい方は「困ったときは」からご連絡ください。ライセンスキーをお持ちの方は入力してください。",
    );
  }
  const token = signToken({
    v: 1,
    kind: "trial",
    lid: "trial",
    aid: trial.id,
    product,
    licensee: "試用",
    hwid,
    iat: nowSec(),
    exp,
    rck: null,
    hck: null,
    chk: true,
  });
  return { ok: true, token, activationId: trial.id };
}
