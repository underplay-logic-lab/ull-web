// ライセンスを発行できる納品ツール（admin の発行フォームの選択肢・API の検証に使う）。
// id はツール側の ull_license.ensure_license(product=...) と一致させる。新しいツールはここに足す。
export const LICENSE_PRODUCTS = [{ id: "framepicker", label: "Underplay FramePicker" }] as const;

export type LicenseProductId = (typeof LICENSE_PRODUCTS)[number]["id"];

export function isLicenseProduct(id: unknown): id is LicenseProductId {
  return typeof id === "string" && LICENSE_PRODUCTS.some((p) => p.id === id);
}

export function licenseProductLabel(id: string): string {
  return LICENSE_PRODUCTS.find((p) => p.id === id)?.label ?? id;
}
