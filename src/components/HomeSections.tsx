"use client";

import type { ComponentType } from "react";
import { Hero } from "@/components/Hero";
import { Studio } from "@/components/Studio";
import { Pricing } from "@/components/Pricing";
import { Products } from "@/components/Products";
import { Contact } from "@/components/Contact";
import { Articles } from "@/components/Articles";
import { SectionManager } from "@/components/SectionManager";
import { useSiteContentEditor } from "@/components/SiteContentEditorProvider";
import { DEFAULT_PAGE_SECTIONS, parsePageSectionsOrder } from "@/lib/siteContents";

const SECTION_REGISTRY: Record<string, { label: string; Component: ComponentType }> = {
  hero: { label: "Hero", Component: Hero },
  studio: { label: "Studio", Component: Studio },
  pricing: { label: "Pricing", Component: Pricing },
  products: { label: "Products", Component: Products },
  contact: { label: "Contact", Component: Contact },
  articles: { label: "Articles", Component: Articles },
};

const DEFAULT_ORDER_JSON = JSON.stringify(DEFAULT_PAGE_SECTIONS);

// Renders the top page's sections in the admin-controlled order/visibility
// from site_contents.page_sections_order (see SectionManager for the
// per-section reorder/hide controls this drives).
export function HomeSections() {
  const { editMode, getValue, setDraft, pushToast } = useSiteContentEditor();
  const order = parsePageSectionsOrder(getValue("page_sections_order", DEFAULT_ORDER_JSON));

  const commit = (next: typeof order) => setDraft("page_sections_order", JSON.stringify(next));

  const moveUp = (index: number) => {
    if (index <= 0) return;
    const next = [...order];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    commit(next);
    pushToast("success", `⬆️ ${SECTION_REGISTRY[order[index].id]?.label ?? order[index].id}セクションを上へ移動しました`);
  };

  const moveDown = (index: number) => {
    if (index >= order.length - 1) return;
    const next = [...order];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    commit(next);
    pushToast("success", `⬇️ ${SECTION_REGISTRY[order[index].id]?.label ?? order[index].id}セクションを下へ移動しました`);
  };

  const toggleVisible = (index: number) => {
    commit(order.map((section, i) => (i === index ? { ...section, visible: !section.visible } : section)));
  };

  return (
    <>
      {order.map((section, index) => {
        const entry = SECTION_REGISTRY[section.id];
        if (!entry) return null;
        if (!section.visible && !editMode) return null;

        const { label, Component } = entry;

        return (
          <div key={section.id} className={`relative ${section.visible ? "" : "opacity-40"}`}>
            {editMode && (
              <SectionManager
                label={section.visible ? label : `${label}（非表示）`}
                isFirst={index === 0}
                isLast={index === order.length - 1}
                visible={section.visible}
                onMoveUp={() => moveUp(index)}
                onMoveDown={() => moveDown(index)}
                onToggleVisible={() => toggleVisible(index)}
              />
            )}
            <Component />
          </div>
        );
      })}
    </>
  );
}
