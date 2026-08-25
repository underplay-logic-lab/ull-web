// Per-feature (Wan Animate 2, or a Custom Workflow's slug) form-state
// persistence so a page reload / accidental tab close doesn't lose whatever
// the user was typing — used by WanAnimateTab.tsx and CustomWorkflowsTab.tsx.
// File inputs (images/videos) are never persisted here: browsers don't allow
// restoring an actual File from storage, so callers must exclude them from
// whatever they pass to saveFormState.

export function studioFormStorageKey(id: string): string {
  return `ull_studio_form_${id}`;
}

export function loadFormState<T>(id: string): Partial<T> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(studioFormStorageKey(id));
    if (!raw) return null;
    return JSON.parse(raw) as Partial<T>;
  } catch {
    // Malformed JSON from an older shape, or storage access denied — treat
    // as "nothing saved" rather than breaking the page.
    return null;
  }
}

export function saveFormState(id: string, state: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(studioFormStorageKey(id), JSON.stringify(state));
  } catch {
    // Quota exceeded / private browsing — persistence is a nice-to-have,
    // never worth failing the form over.
  }
}
