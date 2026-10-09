"use client";

import { useEffect, useState } from "react";
import type { FeatureKey } from "@/lib/features";
import { supabase } from "@/lib/supabaseClient";

// 自分に許可されている機能（GET /api/me/features）。ログイン状態が変わったら取り直す。
// 取得前・失敗時は「許可なし」として扱う（隠す側に倒す）。API 側でも必ず確かめているので表示だけの判定。
export function useFeatures(): { features: FeatureKey[]; has: (f: FeatureKey) => boolean; loaded: boolean } {
  const [features, setFeatures] = useState<FeatureKey[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (accessToken: string | undefined) => {
      if (!accessToken) {
        if (!cancelled) {
          setFeatures([]);
          setLoaded(true);
        }
        return;
      }
      try {
        const res = await fetch("/api/me/features", { headers: { Authorization: `Bearer ${accessToken}` } });
        const json = (await res.json().catch(() => null)) as { features?: FeatureKey[] } | null;
        if (!cancelled) setFeatures(res.ok && Array.isArray(json?.features) ? json.features : []);
      } catch {
        if (!cancelled) setFeatures([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    supabase.auth.getSession().then(({ data }) => void load(data.session?.access_token));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => void load(session?.access_token));
    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  return { features, has: (f) => features.includes(f), loaded };
}
