import React from "react";

interface SettingsTabBarProps {
  activeTab: "primary" | "fallback";
  onTabChange: (tab: "primary" | "fallback") => void;
  primaryLabel: string;
  fallbackLabel: string;
}

export function SettingsTabBar({
  activeTab,
  onTabChange,
  primaryLabel,
  fallbackLabel,
}: SettingsTabBarProps) {
  return (
    <div className="flex gap-1 mb-1">
      <button
        type="button"
        className={`nodrag nopan h-[22px] px-2 rounded-well squircle text-node transition-colors ${
          activeTab === "primary"
            ? "bg-neutral-700 text-neutral-200"
            : "bg-transparent text-neutral-500 hover:text-neutral-400"
        }`}
        onClick={() => {
          if (activeTab !== "primary") onTabChange("primary");
        }}
      >
        {primaryLabel}
      </button>
      <button
        type="button"
        className={`nodrag nopan h-[22px] px-2 rounded-well squircle text-node transition-colors ${
          activeTab === "fallback"
            ? "bg-neutral-700 text-neutral-200"
            : "bg-transparent text-neutral-500 hover:text-neutral-400"
        }`}
        onClick={() => {
          if (activeTab !== "fallback") onTabChange("fallback");
        }}
      >
        {fallbackLabel}
      </button>
    </div>
  );
}
