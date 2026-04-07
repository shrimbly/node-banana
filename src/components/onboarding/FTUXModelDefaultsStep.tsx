"use client";

import { useState, useEffect } from "react";
import { FTUXStepProps } from "@/types/ftux";
import { NodeDefaultsConfig } from "@/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { ProviderModel } from "@/lib/providers/types";
import { loadNodeDefaults, saveNodeDefaults } from "@/store/utils/localStorage";

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

const WaveSpeedIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 512 512" fill="currentColor">
    <path d="M308.946 153.758C314.185 153.758 318.268 158.321 317.516 163.506C306.856 237.02 270.334 302.155 217.471 349.386C211.398 354.812 203.458 357.586 195.315 357.586H127.562C117.863 357.586 110.001 349.724 110.001 340.025V333.552C110.001 326.82 113.882 320.731 119.792 317.505C176.087 286.779 217.883 232.832 232.32 168.537C234.216 160.09 241.509 153.758 250.167 153.758H308.946Z" />
    <path d="M183.573 153.758C188.576 153.758 192.592 157.94 192.069 162.916C187.11 210.12 160.549 250.886 122.45 275.151C116.916 278.676 110 274.489 110 267.928V171.318C110 161.62 117.862 153.758 127.56 153.758H183.573Z" />
    <path d="M414.815 153.758C425.503 153.758 433.734 163.232 431.799 173.743C420.697 234.038 398.943 290.601 368.564 341.414C362.464 351.617 351.307 357.586 339.419 357.586H274.228C266.726 357.586 262.611 348.727 267.233 342.819C306.591 292.513 334.86 233.113 348.361 168.295C350.104 159.925 357.372 153.758 365.922 153.758H414.815Z" />
  </svg>
);

const getProviderIcon = (provider: string) => {
  switch (provider) {
    case "gemini":
      return <GeminiIcon />;
    case "replicate":
      return <ReplicateIcon />;
    case "fal":
      return <FalIcon />;
    case "wavespeed":
      return <WaveSpeedIcon />;
    default:
      return null;
  }
};

export function FTUXModelDefaultsStep({}: FTUXStepProps) {
  const [localDefaults, setLocalDefaults] = useState<NodeDefaultsConfig>({});
  const [showImageDialog, setShowImageDialog] = useState(false);
  const [showVideoDialog, setShowVideoDialog] = useState(false);

  // Load current defaults on mount
  useEffect(() => {
    const currentDefaults = loadNodeDefaults();
    setLocalDefaults(currentDefaults);
  }, []);

  return (
    <div className="py-6 px-6">
      <h3 className="text-lg font-semibold text-neutral-100 mb-2">
        Choose Your Models
      </h3>
      <p className="text-sm text-neutral-400 mb-4">
        Pick your default AI models for images and videos. You can change these later.
      </p>

      <div className="space-y-3">
        {/* Default Image Model */}
        <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-neutral-100">Default Image Model</span>
            <div className="flex items-center gap-2">
              {localDefaults.generateImage?.selectedModel ? (
                <>
                  <div className="flex items-center gap-1.5 text-xs text-neutral-300">
                    {getProviderIcon(localDefaults.generateImage.selectedModel.provider)}
                    <span className="truncate max-w-[150px]">
                      {localDefaults.generateImage.selectedModel.displayName}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowImageDialog(true)}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const { generateImage, ...rest } = localDefaults;
                      setLocalDefaults(rest);
                      saveNodeDefaults(rest);
                    }}
                    className="text-xs text-neutral-400 hover:text-neutral-200"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <>
                  <span className="text-xs text-neutral-400">Gemini nano-banana-pro</span>
                  <button
                    type="button"
                    onClick={() => setShowImageDialog(true)}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
                  >
                    Select
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Default Video Model */}
        <div className="p-3 bg-neutral-900 rounded-lg border border-neutral-700">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-neutral-100">Default Video Model</span>
            <div className="flex items-center gap-2">
              {localDefaults.generateVideo?.selectedModel ? (
                <>
                  <div className="flex items-center gap-1.5 text-xs text-neutral-300">
                    {getProviderIcon(localDefaults.generateVideo.selectedModel.provider)}
                    <span className="truncate max-w-[150px]">
                      {localDefaults.generateVideo.selectedModel.displayName}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowVideoDialog(true)}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const { generateVideo, ...rest } = localDefaults;
                      setLocalDefaults(rest);
                      saveNodeDefaults(rest);
                    }}
                    className="text-xs text-neutral-400 hover:text-neutral-200"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <>
                  <span className="text-xs text-neutral-400">None set</span>
                  <button
                    type="button"
                    onClick={() => setShowVideoDialog(true)}
                    className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
                  >
                    Select
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Model Selection Dialogs */}
      {showImageDialog && (
        <ModelSearchDialog
          isOpen={showImageDialog}
          onClose={() => setShowImageDialog(false)}
          onModelSelected={(model: ProviderModel) => {
            const updatedDefaults = {
              ...localDefaults,
              generateImage: {
                ...localDefaults.generateImage,
                selectedModel: {
                  provider: model.provider,
                  modelId: model.id,
                  displayName: model.name,
                },
              },
            };
            setLocalDefaults(updatedDefaults);
            saveNodeDefaults(updatedDefaults);
            setShowImageDialog(false);
          }}
          initialCapabilityFilter="image"
        />
      )}
      {showVideoDialog && (
        <ModelSearchDialog
          isOpen={showVideoDialog}
          onClose={() => setShowVideoDialog(false)}
          onModelSelected={(model: ProviderModel) => {
            const updatedDefaults = {
              ...localDefaults,
              generateVideo: {
                ...localDefaults.generateVideo,
                selectedModel: {
                  provider: model.provider,
                  modelId: model.id,
                  displayName: model.name,
                },
              },
            };
            setLocalDefaults(updatedDefaults);
            saveNodeDefaults(updatedDefaults);
            setShowVideoDialog(false);
          }}
          initialCapabilityFilter="video"
        />
      )}
    </div>
  );
}
