"use client";

import { useState, useEffect } from "react";
import { FTUXStepProps } from "@/types/ftux";
import { ProviderType } from "@/types";
import { EnvStatusResponse } from "@/app/api/env-status/route";
import { useWorkflowStore } from "@/store/workflowStore";
import { DialogStatus, DialogTextButton } from "@/components/ui/Dialog";
import { TextInput } from "@/components/ui/Controls";
import { cn } from "@/components/nodes/ui/cn";

import { EnvironmentImport } from '@/components/settings/EnvironmentImport';
import { getProviderSettings } from '@/store/utils/localStorage';


interface ProviderInfo {
  id: ProviderType;
  name: string;
  apiKeyUrl: string;
  isRecommended?: boolean;
}

const providers: ProviderInfo[] = [
  { id: "gemini", name: "Google Gemini", apiKeyUrl: "https://aistudio.google.com/apikey", isRecommended: true },
  { id: "fal", name: "fal.ai", apiKeyUrl: "https://fal.ai/dashboard/keys", isRecommended: true },
  { id: "openai", name: "OpenAI", apiKeyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Anthropic", apiKeyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "replicate", name: "Replicate", apiKeyUrl: "https://replicate.com/account/api-tokens" },
  { id: "kie", name: "Kie.ai", apiKeyUrl: "https://kie.ai/api-key" },
  { id: "wavespeed", name: "WaveSpeed", apiKeyUrl: "https://wavespeed.ai/accesskey" },
  { id: "comfy", name: "ComfyUI", apiKeyUrl: "https://platform.comfy.org/profile/api-keys?onboarding=router" },
];

/**
 * Step 2: the desktop .env import, then one ruled row per provider. The
 * heading and lead are the page title, drawn by the modal.
 */
export function FTUXApiKeysStep({}: FTUXStepProps) {
  const updateProviderApiKey = useWorkflowStore((state) => state.updateProviderApiKey);
  const providerSettings = useWorkflowStore((state) => state.providerSettings);
  const [envStatus, setEnvStatus] = useState<EnvStatusResponse | null>(null);
  const [showKey, setShowKey] = useState<Record<ProviderType, boolean>>({
    gemini: false,
    openai: false,
    anthropic: false,
    replicate: false,
    fal: false,
    kie: false,
    wavespeed: false,
    comfy: false,
  });
  const [localKeys, setLocalKeys] = useState<Record<ProviderType, string>>(() => {
    const keys: Record<ProviderType, string> = {
      gemini: "",
      openai: "",
      anthropic: "",
      replicate: "",
      fal: "",
      kie: "",
      wavespeed: "",
      comfy: "",
    };
    for (const id of Object.keys(keys) as ProviderType[]) {
      const saved = providerSettings.providers[id]?.apiKey;
      if (saved) keys[id] = saved;
    }
    return keys;
  });

  useEffect(() => {
    fetch("/api/env-status")
      .then((res) => res.json())
      .then((data: EnvStatusResponse) => setEnvStatus(data))
      .catch(() => setEnvStatus(null));
  }, []);

  const hasEnvKey = (providerId: ProviderType): boolean => {
    if (!envStatus) return false;
    return envStatus[providerId] === true;
  };

  const handleKeyChange = (providerId: ProviderType, value: string) => {
    const newValue = value || "";
    setLocalKeys((prev) => ({
      ...prev,
      [providerId]: newValue,
    }));
    // Save to localStorage immediately (null if empty string)
    updateProviderApiKey(providerId, newValue || null);
  };

  return (
    <div className="flex flex-col">
      <EnvironmentImport onImported={() => {
        const settings = getProviderSettings();
        setLocalKeys(previous => Object.fromEntries(Object.entries(previous).map(([id, value]) => [id, value || settings.providers[id as ProviderType]?.apiKey || ''])) as Record<ProviderType, string>);
      }} />
      <div className="border-t border-chrome-border">
        {providers.map((provider, index) => {
          const hasKey = hasEnvKey(provider.id);

          return (
            <div
              key={provider.id}
              className={cn(
                "flex items-center justify-between gap-4 py-[7px]",
                index > 0 && "border-t border-card"
              )}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <span className="text-[13px] font-medium text-neutral-100 truncate">
                  {provider.name}
                </span>
                <span className="relative group flex shrink-0">
                  <a
                    href={provider.apiKeyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex text-neutral-600 hover:text-neutral-100 transition-colors"
                    aria-label={`Get ${provider.name} API key`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </a>
                  <span className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-2 py-1 bg-[#0f0f0f] text-neutral-200 text-xs rounded-md border border-white/10 whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
                    Get API key{(provider.id === "openai" || provider.id === "anthropic") && " • Used for LLM nodes only"}
                  </span>
                </span>
                {provider.isRecommended && (
                  <DialogStatus tone="ok" className="shrink-0">Recommended</DialogStatus>
                )}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                {hasKey ? (
                  <span className="inline-flex items-center gap-2 text-xs text-neutral-400">
                    Configured via .env
                    <svg
                      className="w-3.5 h-3.5 text-handle-image"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                  </span>
                ) : (
                  <TextInput
                    type={showKey[provider.id] ? "text" : "password"}
                    value={localKeys[provider.id]}
                    onChange={(e) => handleKeyChange(provider.id, e.target.value)}
                    placeholder="Enter key..."
                    aria-label={`${provider.name} API key`}
                    className="w-[168px] h-[30px] px-2.5 text-xs"
                  />
                )}
                {!hasKey && (
                  <DialogTextButton
                    onClick={() =>
                      setShowKey((prev) => ({
                        ...prev,
                        [provider.id]: !prev[provider.id],
                      }))
                    }
                  >
                    {showKey[provider.id] ? "Hide" : "Show"}
                  </DialogTextButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
