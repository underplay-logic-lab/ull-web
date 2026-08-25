"use client";

import { useState, type FormEvent } from "react";
import { Send, CheckCircle, Loader2, AlertCircle } from "lucide-react";
import { contactServices } from "@/lib/data";

type FormState = "idle" | "submitting" | "success" | "error";

export function Contact() {
  const [formState, setFormState] = useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    company: "",
    service: "",
    message: "",
    hp_company_url: "",
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormState("submitting");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "送信に失敗しました。");
      }

      setFormState("success");
      setFormData({
        name: "",
        email: "",
        company: "",
        service: "",
        message: "",
        hp_company_url: "",
      });
    } catch (err) {
      setFormState("error");
      setErrorMessage(
        err instanceof Error ? err.message : "送信に失敗しました。",
      );
    }
  };

  return (
    <section id="contact" data-source-file="src/components/Contact.tsx" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-6">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="mb-3 font-mono text-xs uppercase tracking-widest text-neon-pink">
              Contact
            </p>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              技術支援・受託相談
            </h2>
            <p className="mt-4 leading-relaxed text-muted">
              AIワークフロー設計、ComfyUIカスタムノード開発、業務特化型AI環境の構築まで、
              幅広くご相談を承っています。
              まずはお気軽にご相談ください。
            </p>

            <ul className="mt-8 space-y-3">
              {contactServices.map((service) => (
                <li
                  key={service}
                  className="flex items-center gap-3 text-sm text-foreground/80"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-r from-neon-pink to-neon-violet" />
                  {service}
                </li>
              ))}
            </ul>

            <div className="mt-10 rounded-xl border border-border bg-surface/40 p-5">
              <p className="text-xs font-mono text-muted">Response Time</p>
              <p className="mt-1 text-sm font-medium">
                通常 1〜2 営業日以内にご返信
              </p>
            </div>
          </div>

          <div className="rounded-2xl border-gradient bg-surface/40 p-8">
            {formState === "success" ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <CheckCircle size={48} className="text-neon-pink mb-4" />
                <h3 className="text-xl font-semibold">送信完了</h3>
                <p className="mt-2 text-sm text-muted">
                  お問い合わせありがとうございます。
                  <br />
                  内容を確認の上、折り返しご連絡いたします。
                </p>
                <button
                  type="button"
                  onClick={() => setFormState("idle")}
                  className="mt-6 text-sm text-neon-violet hover:underline"
                >
                  新しいお問い合わせを送る
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                <input
                  type="text"
                  name="hp_company_url"
                  value={formData.hp_company_url}
                  onChange={(e) =>
                    setFormData({ ...formData, hp_company_url: e.target.value })
                  }
                  tabIndex={-1}
                  autoComplete="off"
                  aria-hidden="true"
                  className="absolute -z-10 h-0 w-0 opacity-0"
                  style={{ position: "absolute", left: "-9999px", pointerEvents: "none" }}
                />
                <div className="grid gap-5 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor="name"
                      className="mb-1.5 block text-xs font-medium text-muted"
                    >
                      お名前 <span className="text-neon-pink">*</span>
                    </label>
                    <input
                      id="name"
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) =>
                        setFormData({ ...formData, name: e.target.value })
                      }
                      className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                      placeholder="山田 太郎"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="email"
                      className="mb-1.5 block text-xs font-medium text-muted"
                    >
                      メールアドレス <span className="text-neon-pink">*</span>
                    </label>
                    <input
                      id="email"
                      type="email"
                      required
                      value={formData.email}
                      onChange={(e) =>
                        setFormData({ ...formData, email: e.target.value })
                      }
                      className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="company"
                    className="mb-1.5 block text-xs font-medium text-muted"
                  >
                    会社名 / 組織名
                  </label>
                  <input
                    id="company"
                    type="text"
                    value={formData.company}
                    onChange={(e) =>
                      setFormData({ ...formData, company: e.target.value })
                    }
                    className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                    placeholder="株式会社〇〇"
                  />
                </div>

                <div>
                  <label
                    htmlFor="service"
                    className="mb-1.5 block text-xs font-medium text-muted"
                  >
                    ご相談内容 <span className="text-neon-pink">*</span>
                  </label>
                  <select
                    id="service"
                    required
                    value={formData.service}
                    onChange={(e) =>
                      setFormData({ ...formData, service: e.target.value })
                    }
                    className="w-full rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                  >
                    <option value="">選択してください</option>
                    {contactServices.map((service) => (
                      <option key={service} value={service}>
                        {service}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="message"
                    className="mb-1.5 block text-xs font-medium text-muted"
                  >
                    詳細 <span className="text-neon-pink">*</span>
                  </label>
                  <textarea
                    id="message"
                    required
                    rows={5}
                    value={formData.message}
                    onChange={(e) =>
                      setFormData({ ...formData, message: e.target.value })
                    }
                    className="w-full resize-none rounded-lg border border-border bg-background px-4 py-2.5 text-sm outline-none transition-colors focus:border-neon-violet/50 focus:ring-1 focus:ring-neon-violet/30"
                    placeholder="プロジェクトの概要、予算感、希望スケジュールなど"
                  />
                </div>

                {formState === "error" && errorMessage && (
                  <div className="flex items-start gap-2 rounded-lg border border-neon-pink/30 bg-neon-pink/5 px-4 py-3 text-sm text-neon-pink">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    {errorMessage}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={formState === "submitting"}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-pink to-neon-violet px-6 py-3.5 text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-60 glow-pink"
                >
                  {formState === "submitting" ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      送信中...
                    </>
                  ) : (
                    <>
                      <Send size={16} />
                      送信する
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
