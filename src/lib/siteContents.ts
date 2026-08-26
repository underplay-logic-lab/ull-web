// Shared shape for site_contents — imported by the admin CRUD API/UI and by
// the public /api/site-contents route + useSiteContents hook.

export type SiteContentSection = "hero" | "studio" | "pricing" | "general";

export type SiteContentRow = {
  key: string;
  value: string;
  section: string;
  label: string;
  updated_at: string;
};

// Public-facing shape served by /api/site-contents: just key -> value, so
// components can do `contents[key] ?? fallback` without depending on the
// admin-only section/label bookkeeping columns.
export type PublicSiteContents = Record<string, string>;

export const SITE_CONTENT_SECTION_LABEL: Record<string, string> = {
  hero: "Hero",
  studio: "Studio",
  pricing: "Pricing",
  general: "共通 / フッター",
};

export function getSiteContent(
  contents: PublicSiteContents,
  key: string,
  fallback: string,
): string {
  const value = contents[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

// Backs the SectionManager/HomeSections part of the Visual Editor — the
// homepage's section order + per-section visibility, stored as a JSON
// string in site_contents.page_sections_order (see the migration seeding
// it). Adding a new manageable section later only requires appending it
// here; parsePageSectionsOrder() reconciles any stored order against this
// list so a stale/older saved order never loses or crashes on a new one.
export type PageSectionConfig = { id: string; visible: boolean };

export const DEFAULT_PAGE_SECTIONS: PageSectionConfig[] = [
  { id: "hero", visible: true },
  { id: "studio", visible: true },
  { id: "pricing", visible: true },
  { id: "contact", visible: true },
  { id: "articles", visible: false },
];

export function parsePageSectionsOrder(raw: string): PageSectionConfig[] {
  const knownIds = new Set(DEFAULT_PAGE_SECTIONS.map((s) => s.id));
  const seen = new Set<string>();
  const result: PageSectionConfig[] = [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>).id === "string" &&
          knownIds.has((item as Record<string, unknown>).id as string) &&
          typeof (item as Record<string, unknown>).visible === "boolean" &&
          !seen.has((item as Record<string, unknown>).id as string)
        ) {
          const id = (item as Record<string, unknown>).id as string;
          seen.add(id);
          result.push({ id, visible: (item as Record<string, unknown>).visible as boolean });
        }
      }
    }
  } catch {
    // Fall through — any unrecognized entries are backfilled below, and if
    // parsing failed entirely `seen` is still empty so every default section
    // gets appended in its default order/visibility.
  }

  for (const section of DEFAULT_PAGE_SECTIONS) {
    if (!seen.has(section.id)) result.push(section);
  }

  return result;
}
