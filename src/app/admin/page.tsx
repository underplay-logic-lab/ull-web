"use client";

import { useState } from "react";
import { Activity, DollarSign, FileText, HardDrive, Sparkles, Workflow } from "lucide-react";
import { PresetsTab } from "./_components/PresetsTab";
import { PricingTab } from "./_components/PricingTab";
import { LogsTab } from "./_components/LogsTab";
import { CustomWorkflowsTab } from "./_components/CustomWorkflowsTab";
import { SiteContentsTab } from "./_components/SiteContentsTab";
import { ModalStorageTab } from "./_components/ModalStorageTab";

type AdminTab = "presets" | "pricing" | "logs" | "custom-workflows" | "site-contents" | "modal-storage";

const TABS: { id: AdminTab; label: string; icon: typeof Sparkles }[] = [
  { id: "presets", label: "プリセット管理", icon: Sparkles },
  { id: "pricing", label: "価格・原価設定", icon: DollarSign },
  { id: "logs", label: "実稼働ログ & 粗利監視", icon: Activity },
  { id: "custom-workflows", label: "特化ワークフロー管理", icon: Workflow },
  { id: "site-contents", label: "サイトコンテンツ管理", icon: FileText },
  { id: "modal-storage", label: "Modal ストレージ & ノード管理", icon: HardDrive },
];

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<AdminTab>("presets");

  return (
    <div>
      <div className="mb-8 flex flex-wrap gap-2 border-b border-border pb-4">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 rounded-full border px-4 py-2 text-xs font-mono font-medium transition-colors ${
                isActive
                  ? "border-neon-pink/40 bg-neon-pink/10 text-neon-pink"
                  : "border-border bg-surface/40 text-muted hover:border-neon-violet/40 hover:text-foreground"
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "presets" && <PresetsTab />}
      {activeTab === "pricing" && <PricingTab />}
      {activeTab === "logs" && <LogsTab />}
      {activeTab === "custom-workflows" && <CustomWorkflowsTab />}
      {activeTab === "site-contents" && <SiteContentsTab />}
      {activeTab === "modal-storage" && <ModalStorageTab />}
    </div>
  );
}
