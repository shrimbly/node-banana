"use client";

import { useState, useEffect } from "react";
import type { ReactElement } from "react";
import { FTUXStepProps } from "@/types/ftux";
import { ProviderType } from "@/types";
import { EnvStatusResponse } from "@/app/api/env-status/route";
import { useWorkflowStore } from "@/store/workflowStore";

// Provider icons
const GeminiIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
  </svg>
);

const OpenAIIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
  </svg>
);

const AnthropicIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <rect x="9" y="2" width="2" height="20" />
    <rect x="13" y="2" width="2" height="20" />
  </svg>
);

const ReplicateIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 1000 1000" fill="currentColor">
    <polygon points="1000,427.6 1000,540.6 603.4,540.6 603.4,1000 477,1000 477,427.6" />
    <polygon points="1000,213.8 1000,327 364.8,327 364.8,1000 238.4,1000 238.4,213.8" />
    <polygon points="1000,0 1000,113.2 126.4,113.2 126.4,1000 0,1000 0,0" />
  </svg>
);

const FalIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 1855 1855" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M1181.65 78C1212.05 78 1236.42 101.947 1239.32 131.261C1265.25 392.744 1480.07 600.836 1750.02 625.948C1780.28 628.764 1805 652.366 1805 681.816V1174.18C1805 1203.63 1780.28 1227.24 1750.02 1230.05C1480.07 1255.16 1265.25 1463.26 1239.32 1724.74C1236.42 1754.05 1212.05 1778 1181.65 1778H673.354C642.951 1778 618.585 1754.05 615.678 1724.74C589.754 1463.26 374.927 1255.16 104.984 1230.05C74.7212 1227.24 50 1203.63 50 1174.18V681.816C50 652.366 74.7213 628.764 104.984 625.948C374.927 600.836 589.754 392.744 615.678 131.261C618.585 101.946 642.951 78 673.353 78H1181.65ZM402.377 926.561C402.377 1209.41 638.826 1438.71 930.501 1438.71C1222.18 1438.71 1458.63 1209.41 1458.63 926.561C1458.63 643.709 1222.18 414.412 930.501 414.412C638.826 414.412 402.377 643.709 402.377 926.561Z" />
  </svg>
);

const KieIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"/>
  </svg>
);

const WaveSpeedIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 512 512" fill="currentColor">
    <path d="M308.946 153.758C314.185 153.758 318.268 158.321 317.516 163.506C306.856 237.02 270.334 302.155 217.471 349.386C211.398 354.812 203.458 357.586 195.315 357.586H127.562C117.863 357.586 110.001 349.724 110.001 340.025V333.552C110.001 326.82 113.882 320.731 119.792 317.505C176.087 286.779 217.883 232.832 232.32 168.537C234.216 160.09 241.509 153.758 250.167 153.758H308.946Z" />
    <path d="M183.573 153.758C188.576 153.758 192.592 157.94 192.069 162.916C187.11 210.12 160.549 250.886 122.45 275.151C116.916 278.676 110 274.489 110 267.928V171.318C110 161.62 117.862 153.758 127.56 153.758H183.573Z" />
    <path d="M414.815 153.758C425.503 153.758 433.734 163.232 431.799 173.743C420.697 234.038 398.943 290.601 368.564 341.414C362.464 351.617 351.307 357.586 339.419 357.586H274.228C266.726 357.586 262.611 348.727 267.233 342.819C306.591 292.513 334.86 233.113 348.361 168.295C350.104 159.925 357.372 153.758 365.922 153.758H414.815Z" />
  </svg>
);

interface ProviderInfo {
  id: ProviderType;
  name: string;
  icon: () => ReactElement;
  apiKeyUrl: string;
  isRecommended?: boolean;
}

const providers: ProviderInfo[] = [
  { id: "gemini", name: "Google Gemini", icon: GeminiIcon, apiKeyUrl: "https://aistudio.google.com/apikey", isRecommended: true },
  { id: "fal", name: "fal.ai", icon: FalIcon, apiKeyUrl: "https://fal.ai/dashboard/keys", isRecommended: true },
  { id: "openai", name: "OpenAI", icon: OpenAIIcon, apiKeyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", name: "Anthropic", icon: AnthropicIcon, apiKeyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "replicate", name: "Replicate", icon: ReplicateIcon, apiKeyUrl: "https://replicate.com/account/api-tokens" },
  { id: "kie", name: "Kie.ai", icon: KieIcon, apiKeyUrl: "https://kie.ai/api-key" },
  { id: "wavespeed", name: "WaveSpeed", icon: WaveSpeedIcon, apiKeyUrl: "https://wavespeed.ai/accesskey" },
];

export function FTUXApiKeysStep({}: FTUXStepProps) {
  const updateProviderApiKey = useWorkflowStore((state) => state.updateProviderApiKey);
  const [envStatus, setEnvStatus] = useState<EnvStatusResponse | null>(null);
  const [showKey, setShowKey] = useState<Record<ProviderType, boolean>>({
    gemini: false,
    openai: false,
    anthropic: false,
    replicate: false,
    fal: false,
    kie: false,
    wavespeed: false,
  });
  const [localKeys, setLocalKeys] = useState<Record<ProviderType, string>>({
    gemini: "",
    openai: "",
    anthropic: "",
    replicate: "",
    fal: "",
    kie: "",
    wavespeed: "",
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
    <div className="py-6 px-6">
      <h3 className="text-lg font-semibold text-neutral-100 mb-2">
        API Keys
      </h3>
      <p className="text-sm text-neutral-400 mb-4">
        Add keys here to use AI providers (stored in browser), or save them to your .env file for better security and persistence.
      </p>

      <div className="space-y-2">
        {providers.map((provider) => {
          const Icon = provider.icon;
          const hasKey = hasEnvKey(provider.id);

          return (
            <div
              key={provider.id}
              className={`p-3 rounded-lg border ${
                provider.isRecommended
                  ? "bg-green-500/10 border-green-600/30"
                  : "bg-neutral-900 border-neutral-700"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="text-neutral-300 shrink-0">
                    <Icon />
                  </div>
                  <span className="text-sm font-medium text-neutral-100 truncate">
                    {provider.name}
                  </span>
                  <div className="relative group shrink-0">
                    <a
                      href={provider.apiKeyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-neutral-400 hover:text-neutral-200 transition-colors"
                      aria-label={`Get ${provider.name} API key`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </a>
                    <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-2 py-1 bg-neutral-900 text-neutral-200 text-xs rounded border border-neutral-700 whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
                      Get API key{(provider.id === "openai" || provider.id === "anthropic") && " • Used for LLM nodes only"}
                    </div>
                  </div>
                  {provider.isRecommended && (
                    <span className="text-xs text-green-400 shrink-0">Recommended</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {hasKey ? (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-green-400">
                        Configured via .env
                      </span>
                      <svg
                        className="w-4 h-4 text-green-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    </div>
                  ) : (
                    <input
                      type={showKey[provider.id] ? "text" : "password"}
                      value={localKeys[provider.id]}
                      onChange={(e) => handleKeyChange(provider.id, e.target.value)}
                      placeholder="Enter key..."
                      className="w-32 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
                    />
                  )}
                  {!hasKey && (
                    <button
                      type="button"
                      onClick={() =>
                        setShowKey((prev) => ({
                          ...prev,
                          [provider.id]: !prev[provider.id],
                        }))
                      }
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      {showKey[provider.id] ? "Hide" : "Show"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
