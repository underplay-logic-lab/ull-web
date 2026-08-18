"use client";

import { useEffect } from "react";

/**
 * Client-side navigation into "/" can arrive with a stale scroll offset
 * restored by the router cache. When there is no target hash (i.e. this
 * isn't a "/#section" deep link), force the viewport back to the true top.
 */
export function HomeScrollReset() {
  useEffect(() => {
    if (!window.location.hash) {
      window.scrollTo(0, 0);
    }
  }, []);

  return null;
}
