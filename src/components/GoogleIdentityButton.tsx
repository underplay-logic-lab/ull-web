"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";

// Google sign-in via Google Identity Services + supabase.auth.signInWithIdToken.
// Unlike signInWithOAuth, the browser never visits <project>.supabase.co: Google
// hands us an ID token in a popup and we trade it for a session with a direct
// API call. Requires the page origin to be listed under "Authorized JavaScript
// origins" of this OAuth client in Google Cloud, and the same client ID to be
// accepted by Supabase's Google provider.

type CredentialResponse = { credential?: string };

type GoogleAccountsId = {
  initialize: (config: {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    nonce?: string;
    ux_mode?: "popup" | "redirect";
    use_fedcm_for_button?: boolean;
  }) => void;
  renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleAccountsId } };
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";
let gsiLoader: Promise<GoogleAccountsId> | null = null;

function loadGsi(): Promise<GoogleAccountsId> {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (!gsiLoader) {
    gsiLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      script.onload = () => {
        const id = window.google?.accounts?.id;
        if (id) resolve(id);
        else reject(new Error("Google Identity Services failed to initialise"));
      };
      script.onerror = () => {
        gsiLoader = null;
        script.remove();
        reject(new Error("Failed to load Google Identity Services"));
      };
      document.head.appendChild(script);
    });
  }
  return gsiLoader;
}

// Google embeds sha256(nonce) in the ID token; Supabase re-hashes the raw
// nonce we give it and compares, which blocks replay of a stolen token.
async function makeNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { raw, hashed };
}

type Props = {
  clientId: string;
  onSignedIn: () => void;
};

export function GoogleIdentityButton({ clientId, onSignedIn }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSignedInRef = useRef(onSignedIn);
  useEffect(() => {
    onSignedInRef.current = onSignedIn;
  }, [onSignedIn]);
  const [status, setStatus] = useState<"loading" | "ready" | "signing-in" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [gsi, nonce] = await Promise.all([loadGsi(), makeNonce()]);
        if (cancelled || !containerRef.current) return;

        gsi.initialize({
          client_id: clientId,
          nonce: nonce.hashed,
          ux_mode: "popup",
          use_fedcm_for_button: true,
          callback: async (response) => {
            if (!response.credential) {
              setError("Googleからの応答を受け取れませんでした。もう一度お試しください。");
              return;
            }
            setError(null);
            setStatus("signing-in");
            const { error: signInError } = await supabase.auth.signInWithIdToken({
              provider: "google",
              token: response.credential,
              nonce: nonce.raw,
            });
            if (cancelled) return;
            if (signInError) {
              setStatus("ready");
              setError(`Googleログインに失敗しました: ${signInError.message}`);
              return;
            }
            onSignedInRef.current();
          },
        });

        const width = Math.min(400, Math.max(200, containerRef.current.offsetWidth));
        gsi.renderButton(containerRef.current, {
          type: "standard",
          theme: "filled_black",
          size: "large",
          shape: "pill",
          text: "signin_with",
          logo_alignment: "center",
          locale: "ja",
          width,
        });
        setStatus("ready");
      } catch {
        if (cancelled) return;
        setStatus("error");
        setError("Googleログインを読み込めませんでした。通信環境をご確認のうえ、再度お試しください。");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  return (
    <div className="mt-4">
      <div
        ref={containerRef}
        className={`flex w-full justify-center ${
          status === "signing-in" ? "hidden" : status === "loading" ? "" : "min-h-[44px]"
        }`}
      />
      {status === "loading" && (
        <p className="flex items-center justify-center gap-2 text-xs text-muted">
          <Loader2 size={14} className="animate-spin" />
          読み込み中...
        </p>
      )}
      {status === "signing-in" && (
        <p className="flex min-h-[44px] items-center justify-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          ログインしています...
        </p>
      )}
      {error && (
        <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
