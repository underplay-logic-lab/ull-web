"use client";

import { useEffect, useState } from "react";
import type { PublicSiteContents } from "@/lib/siteContents";

// Fetch-on-mount, same convention as useProfileCredits/the Studio tabs'
// presets+pricing fetches: components render their hardcoded fallback text
// immediately, then swap in the DB value once this resolves (or silently
// keep the fallback forever if the fetch fails).
export function useSiteContents() {
  const [contents, setContents] = useState<PublicSiteContents>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/site-contents");
        const data = await res.json();
        if (res.ok) {
          setContents(data.contents as PublicSiteContents);
        } else {
          console.error("[useSiteContents] failed to load:", data?.error);
        }
      } catch (err) {
        console.error("[useSiteContents] failed to load:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return { contents, loading, setContents };
}
