"use client";

import { useState, useEffect } from "react";
import { generateWorkflowId, useWorkflowStore } from "@/store/workflowStore";
import { ProviderType, ProviderSettings, NodeDefaultsConfig, LLMProvider, LLMModelType } from "@/types";
import { EnvStatusResponse } from "@/app/api/env-status/route";
import { loadNodeDefaults, saveNodeDefaults } from "@/store/utils/localStorage";
import { ProviderModel } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";

// LLM provider and model options (mirrored from LLMGenerateNode)
const LLM_PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
];

const LLM_MODELS: Record<LLMProvider, { value: LLMModelType; label: string }[]> = {
  google: [
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-3-pro-preview", label: "Gemini 3.0 Pro" },
  ],
  openai: [
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ],
};

// Provider icons
const GeminiIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
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

// Get provider icon component
const getProviderIcon = (provider: ProviderType) => {
  switch (provider) {
    case "gemini":
      return <GeminiIcon />;
    case "replicate":
      return <ReplicateIcon />;
    case "fal":
      return <FalIcon />;
    default:
      return null;
  }
};

interface ProjectSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (id: string, name: string, directoryPath: string) => void;
  mode: "new" | "settings";
}

export function ProjectSetupModal({
  isOpen,
  onClose,
  onSave,
  mode,
}: ProjectSetupModalProps) {
  const {
    workflowName,
    saveDirectoryPath,
    useExternalImageStorage,
    setUseExternalImageStorage,
    providerSettings,
    updateProviderApiKey,
    toggleProvider,
  } = useWorkflowStore();

  // Tab state
  const [activeTab, setActiveTab] = useState<"project" | "providers" | "nodeDefaults">("project");

  // Project tab state
  const [name, setName] = useState("");
  const [directoryPath, setDirectoryPath] = useState("");
  const [externalStorage, setExternalStorage] = useState(true);
  const [isValidating, setIsValidating] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Provider tab state
  const [localProviders, setLocalProviders] = useState<ProviderSettings>(providerSettings);
  const [showApiKey, setShowApiKey] = useState<Record<ProviderType, boolean>>({
    gemini: false,
    openai: false,
    replicate: false,
    fal: false,
  });
  const [overrideActive, setOverrideActive] = useState<Record<ProviderType, boolean>>({
    gemini: false,
    openai: false,
    replicate: false,
    fal: false,
  });
  const [envStatus, setEnvStatus] = useState<EnvStatusResponse | null>(null);

  // Node defaults tab state
  const [localNodeDefaults, setLocalNodeDefaults] = useState<NodeDefaultsConfig>({});
  const [showImageModelDialog, setShowImageModelDialog] = useState(false);
  const [showVideoModelDialog, setShowVideoModelDialog] = useState(false);

  // Pre-fill when opening in settings mode
  useEffect(() => {
    if (isOpen) {
      // Reset to project tab when opening
      if (mode === "new") {
        setActiveTab("project");
      }

      if (mode === "settings") {
        setName(workflowName || "");
        setDirectoryPath(saveDirectoryPath || "");
        setExternalStorage(useExternalImageStorage);
      } else if (mode === "new") {
        setName("");
        setDirectoryPath("");
        setExternalStorage(true);
      }

      // Sync local providers state
      setLocalProviders(providerSettings);
      setShowApiKey({ gemini: false, openai: false, replicate: false, fal: false });
      // Initialize override as active if user already has a key set
      setOverrideActive({
        gemini: !!providerSettings.providers.gemini?.apiKey,
        openai: !!providerSettings.providers.openai?.apiKey,
        replicate: !!providerSettings.providers.replicate?.apiKey,
        fal: !!providerSettings.providers.fal?.apiKey,
      });
      setError(null);

      // Load node defaults
      setLocalNodeDefaults(loadNodeDefaults());
      setShowImageModelDialog(false);
      setShowVideoModelDialog(false);

      // Fetch env status
      fetch("/api/env-status")
        .then((res) => res.json())
        .then((data: EnvStatusResponse) => setEnvStatus(data))
        .catch(() => setEnvStatus(null));
    }
  }, [isOpen, mode, workflowName, saveDirectoryPath, useExternalImageStorage, providerSettings]);

  const handleBrowse = async () => {
    setIsBrowsing(true);
    setError(null);

    try {
      const response = await fetch("/api/browse-directory");
      const result = await response.json();

      if (!result.success) {
        setError(result.error || "Failed to open directory picker");
        return;
      }

      if (result.cancelled) {
        return;
      }

      if (result.path) {
        setDirectoryPath(result.path);
      }
    } catch (err) {
      setError(
        `Failed to open directory picker: ${err instanceof Error ? err.message : "Unknown error"}`
      );
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleSaveProject = async () => {
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }

    if (!directoryPath.trim()) {
      setError("Project directory is required");
      return;
    }

    setIsValidating(true);
    setError(null);

    try {
      // Validate project directory exists
      const response = await fetch(
        `/api/workflow?path=${encodeURIComponent(directoryPath.trim())}`
      );
      const result = await response.json();

      if (!result.exists) {
        setError("Project directory does not exist");
        setIsValidating(false);
        return;
      }

      if (!result.isDirectory) {
        setError("Project path is not a directory");
        setIsValidating(false);
        return;
      }

      const id = mode === "new" ? generateWorkflowId() : useWorkflowStore.getState().workflowId || generateWorkflowId();
      // Update external storage setting
      setUseExternalImageStorage(externalStorage);
      onSave(id, name.trim(), directoryPath.trim());
      setIsValidating(false);
    } catch (err) {
      setError(
        `Failed to validate directory: ${err instanceof Error ? err.message : "Unknown error"}`
      );
      setIsValidating(false);
    }
  };

  const handleSaveProviders = () => {
    // Save each provider's settings
    const providerIds: ProviderType[] = ["gemini", "openai", "replicate", "fal"];
    for (const providerId of providerIds) {
      const local = localProviders.providers[providerId];
      const current = providerSettings.providers[providerId];

      if (!local || !current) continue;

      // Update enabled state if changed
      if (local.enabled !== current.enabled) {
        toggleProvider(providerId, local.enabled);
      }

      // Update API key if changed
      if (local.apiKey !== current.apiKey) {
        updateProviderApiKey(providerId, local.apiKey);
      }
    }
    onClose();
  };

  const handleSaveNodeDefaults = () => {
    saveNodeDefaults(localNodeDefaults);
    onClose();
  };

  const handleSave = () => {
    if (activeTab === "project") {
      handleSaveProject();
    } else if (activeTab === "providers") {
      handleSaveProviders();
    } else {
      handleSaveNodeDefaults();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !isValidating && !isBrowsing) {
      handleSave();
    }
    if (e.key === "Escape") {
      onClose();
    }
  };

  const updateLocalProvider = (
    providerId: ProviderType,
    updates: { enabled?: boolean; apiKey?: string | null }
  ) => {
    setLocalProviders((prev) => ({
      providers: {
        ...prev.providers,
        [providerId]: {
          ...prev.providers[providerId],
          ...updates,
        },
      },
    }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div
        className="bg-neutral-800 rounded-lg p-6 w-[480px] border border-neutral-700 shadow-xl"
        onKeyDown={handleKeyDown}
      >
        <h2 className="text-lg font-semibold text-neutral-100 mb-4">
          {mode === "new" ? "New Project" : "Project Settings"}
        </h2>

        {/* Tab Bar */}
        <div className="flex gap-4 border-b border-neutral-700 mb-4">
          <button
            onClick={() => setActiveTab("project")}
            className={`pb-2 text-sm ${activeTab === "project" ? "text-neutral-100 border-b-2 border-white" : "text-neutral-400"}`}
          >
            Project
          </button>
          <button
            onClick={() => setActiveTab("providers")}
            className={`pb-2 text-sm ${activeTab === "providers" ? "text-neutral-100 border-b-2 border-white" : "text-neutral-400"}`}
          >
            Providers
          </button>
          <button
            onClick={() => setActiveTab("nodeDefaults")}
            className={`pb-2 text-sm ${activeTab === "nodeDefaults" ? "text-neutral-100 border-b-2 border-white" : "text-neutral-400"}`}
          >
            Node Defaults
          </button>
        </div>

        {/* Project Tab Content */}
        {activeTab === "project" && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm text-neutral-400 mb-1">
                Project Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                autoFocus
                className="w-full px-3 py-2 bg-neutral-900 border border-neutral-600 rounded text-neutral-100 text-sm focus:outline-none focus:border-neutral-500"
              />
            </div>

            <div>
              <label className="block text-sm text-neutral-400 mb-1">
                Project Directory
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={directoryPath}
                  onChange={(e) => setDirectoryPath(e.target.value)}
                  placeholder="/Users/username/projects/my-project"
                  className="flex-1 px-3 py-2 bg-neutral-900 border border-neutral-600 rounded text-neutral-100 text-sm focus:outline-none focus:border-neutral-500"
                />
                <button
                  type="button"
                  onClick={handleBrowse}
                  disabled={isBrowsing}
                  className="px-3 py-2 bg-neutral-700 hover:bg-neutral-600 disabled:bg-neutral-700 disabled:opacity-50 text-neutral-200 text-sm rounded transition-colors"
                >
                  {isBrowsing ? "..." : "Browse"}
                </button>
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                Workflow files and images will be saved here. Subfolders for inputs and generations will be auto-created.
              </p>
            </div>

            <div className="pt-2 border-t border-neutral-700">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!externalStorage}
                  onChange={(e) => setExternalStorage(!e.target.checked)}
                  className="w-4 h-4 rounded border-neutral-600 bg-neutral-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-neutral-800"
                />
                <div>
                  <span className="text-sm text-neutral-200">Embed images as base64</span>
                  <p className="text-xs text-neutral-500">
                    Embeds all images in workflow, larger workflow files. Can hit memory limits on very large workflows.
                  </p>
                </div>
              </label>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
        )}

        {/* Providers Tab Content */}
        {activeTab === "providers" && (
          <div className="space-y-3">
            {/* Gemini Provider */}
            <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-100">Google Gemini</span>
                {envStatus?.gemini && !overrideActive.gemini ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-green-400">Configured via .env</span>
                    <button
                      type="button"
                      onClick={() => setOverrideActive((prev) => ({ ...prev, gemini: true }))}
                      className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                      Override
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type={showApiKey.gemini ? "text" : "password"}
                      value={localProviders.providers.gemini?.apiKey || ""}
                      onChange={(e) => updateLocalProvider("gemini", { apiKey: e.target.value || null })}
                      placeholder="AIza..."
                      className="w-48 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((prev) => ({ ...prev, gemini: !prev.gemini }))}
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      {showApiKey.gemini ? "Hide" : "Show"}
                    </button>
                    {envStatus?.gemini && (
                      <button
                        type="button"
                        onClick={() => {
                          setOverrideActive((prev) => ({ ...prev, gemini: false }));
                          updateLocalProvider("gemini", { apiKey: null });
                        }}
                        className="text-xs text-neutral-500 hover:text-neutral-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* OpenAI Provider */}
            <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-100">OpenAI</span>
                {envStatus?.openai && !overrideActive.openai ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-green-400">Configured via .env</span>
                    <button
                      type="button"
                      onClick={() => setOverrideActive((prev) => ({ ...prev, openai: true }))}
                      className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                      Override
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type={showApiKey.openai ? "text" : "password"}
                      value={localProviders.providers.openai?.apiKey || ""}
                      onChange={(e) => updateLocalProvider("openai", { apiKey: e.target.value || null })}
                      placeholder="sk-..."
                      className="w-48 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((prev) => ({ ...prev, openai: !prev.openai }))}
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      {showApiKey.openai ? "Hide" : "Show"}
                    </button>
                    {envStatus?.openai && (
                      <button
                        type="button"
                        onClick={() => {
                          setOverrideActive((prev) => ({ ...prev, openai: false }));
                          updateLocalProvider("openai", { apiKey: null });
                        }}
                        className="text-xs text-neutral-500 hover:text-neutral-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Replicate Provider */}
            <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-100">Replicate</span>
                {envStatus?.replicate && !overrideActive.replicate ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-green-400">Configured via .env</span>
                    <button
                      type="button"
                      onClick={() => setOverrideActive((prev) => ({ ...prev, replicate: true }))}
                      className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                      Override
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type={showApiKey.replicate ? "text" : "password"}
                      value={localProviders.providers.replicate?.apiKey || ""}
                      onChange={(e) => updateLocalProvider("replicate", { apiKey: e.target.value || null })}
                      placeholder="r8_..."
                      className="w-48 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((prev) => ({ ...prev, replicate: !prev.replicate }))}
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      {showApiKey.replicate ? "Hide" : "Show"}
                    </button>
                    {envStatus?.replicate && (
                      <button
                        type="button"
                        onClick={() => {
                          setOverrideActive((prev) => ({ ...prev, replicate: false }));
                          updateLocalProvider("replicate", { apiKey: null });
                        }}
                        className="text-xs text-neutral-500 hover:text-neutral-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* fal.ai Provider */}
            <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-100">fal.ai</span>
                {envStatus?.fal && !overrideActive.fal ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-green-400">Configured via .env</span>
                    <button
                      type="button"
                      onClick={() => setOverrideActive((prev) => ({ ...prev, fal: true }))}
                      className="px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                      Override
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type={showApiKey.fal ? "text" : "password"}
                      value={localProviders.providers.fal?.apiKey || ""}
                      onChange={(e) => updateLocalProvider("fal", { apiKey: e.target.value || null })}
                      placeholder="..."
                      className="w-48 px-2 py-1 bg-neutral-800 border border-neutral-600 rounded text-neutral-100 text-xs focus:outline-none focus:border-neutral-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((prev) => ({ ...prev, fal: !prev.fal }))}
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      {showApiKey.fal ? "Hide" : "Show"}
                    </button>
                    {envStatus?.fal && (
                      <button
                        type="button"
                        onClick={() => {
                          setOverrideActive((prev) => ({ ...prev, fal: false }));
                          updateLocalProvider("fal", { apiKey: null });
                        }}
                        className="text-xs text-neutral-500 hover:text-neutral-300"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <p className="text-xs text-neutral-500 mt-2">
              Add API keys via <code className="px-1 py-0.5 bg-neutral-800 rounded">.env.local</code> for better security. Keys added here override .env and are stored in your browser.
            </p>
          </div>
        )}

        {/* Node Defaults Tab Content */}
        {activeTab === "nodeDefaults" && (
          <div className="space-y-3">
            {/* GenerateImage Section */}
            <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-100">Default Image Model</span>
                <div className="flex items-center gap-2">
                  {localNodeDefaults.generateImage?.selectedModel ? (
                    <>
                      <div className="flex items-center gap-1.5 text-xs text-neutral-300">
                        {getProviderIcon(localNodeDefaults.generateImage.selectedModel.provider)}
                        <span className="truncate max-w-[150px]">
                          {localNodeDefaults.generateImage.selectedModel.displayName}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowImageModelDialog(true)}
                        className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
                      >
                        Change
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const { generateImage, ...rest } = localNodeDefaults;
                          setLocalNodeDefaults(rest);
                        }}
                        className="text-xs text-neutral-400 hover:text-neutral-200"
                      >
                        Clear
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-neutral-500">System default (Gemini nano-banana-pro)</span>
                      <button
                        type="button"
                        onClick={() => setShowImageModelDialog(true)}
                        className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
                      >
                        Select Model
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* GenerateVideo Section */}
            <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-100">Default Video Model</span>
                <div className="flex items-center gap-2">
                  {localNodeDefaults.generateVideo?.selectedModel ? (
                    <>
                      <div className="flex items-center gap-1.5 text-xs text-neutral-300">
                        {getProviderIcon(localNodeDefaults.generateVideo.selectedModel.provider)}
                        <span className="truncate max-w-[150px]">
                          {localNodeDefaults.generateVideo.selectedModel.displayName}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowVideoModelDialog(true)}
                        className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
                      >
                        Change
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const { generateVideo, ...rest } = localNodeDefaults;
                          setLocalNodeDefaults(rest);
                        }}
                        className="text-xs text-neutral-400 hover:text-neutral-200"
                      >
                        Clear
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-neutral-500">None set (select on first use)</span>
                      <button
                        type="button"
                        onClick={() => setShowVideoModelDialog(true)}
                        className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
                      >
                        Select Model
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* LLM Section */}
            <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-neutral-100">Default LLM Settings</span>
                  {localNodeDefaults.llm && (
                    <button
                      type="button"
                      onClick={() => {
                        const { llm, ...rest } = localNodeDefaults;
                        setLocalNodeDefaults(rest);
                      }}
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {!localNodeDefaults.llm ? (
                  <p className="text-xs text-neutral-500">Using system defaults (Google Gemini 3 Flash)</p>
                ) : null}

                {/* Provider dropdown */}
                <div className="flex items-center gap-2">
                  <label className="text-xs text-neutral-400 w-20">Provider</label>
                  <select
                    value={localNodeDefaults.llm?.provider || "google"}
                    onChange={(e) => {
                      const newProvider = e.target.value as LLMProvider;
                      const firstModelForProvider = LLM_MODELS[newProvider][0].value;
                      setLocalNodeDefaults(prev => ({
                        ...prev,
                        llm: {
                          ...prev.llm,
                          provider: newProvider,
                          model: firstModelForProvider,
                        }
                      }));
                    }}
                    className="flex-1 px-2 py-1 text-xs bg-neutral-800 border border-neutral-600 rounded text-neutral-100 focus:outline-none focus:border-neutral-500"
                  >
                    {LLM_PROVIDERS.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>

                {/* Model dropdown */}
                <div className="flex items-center gap-2">
                  <label className="text-xs text-neutral-400 w-20">Model</label>
                  <select
                    value={localNodeDefaults.llm?.model || LLM_MODELS[localNodeDefaults.llm?.provider || "google"][0].value}
                    onChange={(e) => {
                      setLocalNodeDefaults(prev => ({
                        ...prev,
                        llm: { ...prev.llm, model: e.target.value as LLMModelType }
                      }));
                    }}
                    className="flex-1 px-2 py-1 text-xs bg-neutral-800 border border-neutral-600 rounded text-neutral-100 focus:outline-none focus:border-neutral-500"
                  >
                    {LLM_MODELS[localNodeDefaults.llm?.provider || "google"].map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>

                {/* Temperature slider */}
                <div className="flex items-center gap-2">
                  <label className="text-xs text-neutral-400 w-20">
                    Temp: {(localNodeDefaults.llm?.temperature ?? 0.7).toFixed(1)}
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={localNodeDefaults.llm?.temperature ?? 0.7}
                    onChange={(e) => {
                      setLocalNodeDefaults(prev => ({
                        ...prev,
                        llm: { ...prev.llm, temperature: parseFloat(e.target.value) }
                      }));
                    }}
                    className="flex-1 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-neutral-400"
                  />
                </div>
              </div>
            </div>

            <p className="text-xs text-neutral-500 mt-2">
              These defaults are applied when creating nodes via keyboard shortcuts (Shift+G, Shift+L, etc).
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={activeTab === "project" && (isValidating || isBrowsing)}
            className="px-4 py-2 text-sm bg-white text-neutral-900 rounded hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {activeTab === "project"
              ? (isValidating ? "Validating..." : mode === "new" ? "Create" : "Save")
              : "Save"
            }
          </button>
        </div>
      </div>

      {/* Model Selection Dialogs */}
      {showImageModelDialog && (
        <ModelSearchDialog
          isOpen={showImageModelDialog}
          onClose={() => setShowImageModelDialog(false)}
          onModelSelected={(model: ProviderModel) => {
            setLocalNodeDefaults(prev => ({
              ...prev,
              generateImage: {
                ...prev.generateImage,
                selectedModel: {
                  provider: model.provider,
                  modelId: model.id,
                  displayName: model.name,
                }
              }
            }));
            setShowImageModelDialog(false);
          }}
          initialCapabilityFilter="image"
        />
      )}
      {showVideoModelDialog && (
        <ModelSearchDialog
          isOpen={showVideoModelDialog}
          onClose={() => setShowVideoModelDialog(false)}
          onModelSelected={(model: ProviderModel) => {
            setLocalNodeDefaults(prev => ({
              ...prev,
              generateVideo: {
                ...prev.generateVideo,
                selectedModel: {
                  provider: model.provider,
                  modelId: model.id,
                  displayName: model.name,
                }
              }
            }));
            setShowVideoModelDialog(false);
          }}
          initialCapabilityFilter="video"
        />
      )}
    </div>
  );
}
