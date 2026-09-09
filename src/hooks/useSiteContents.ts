"use client";

import { useEffect, useState } from "react";
import type { PublicSiteContents } from "@/lib/siteContents";

// Every consumer reads values via getSiteContent(contents, key, fallback), so
// an empty map is already a fully-working fallback — each component keeps its
// own hardcoded text. Named for parity with the Studio tabs' fallback consts.
const FALLBACK_SITE_CONTENTS: PublicSiteContents = {};

// Fetch-on-mount, same convention as useProfileCredits/the Studio tabs'
// presets+pricing fetches: components render their hardcoded fallback text
// immediately, then swap in the DB value once this resolves (or silently
// keep the fallback forever if the fetch fails).
export function useSiteContents() {
  const [contents, setContents] = useState<PublicSiteContents>(FALLBACK_SITE_CONTENTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/site-contents");
        const data = await res.json().catch(() => null);
        if (res.ok && data?.contents && typeof data.contents === "object") {
          setContents(data.contents as PublicSiteContents);
        } else {
          // Non-fatal: keep the fallback so the page renders with its own
          // hardcoded copy instead of tripping the dev error overlay.
          console.warn(
            "[useSiteContents] site-contents API unavailable, using fallback:",
            data?.error ?? res.status,
          );
          setContents(FALLBACK_SITE_CONTENTS);
        }
      } catch (err) {
        console.warn("[useSiteContents] site-contents API request failed, using fallback:", err);
        setContents(FALLBACK_SITE_CONTENTS);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return { contents, loading, setContents };
}
