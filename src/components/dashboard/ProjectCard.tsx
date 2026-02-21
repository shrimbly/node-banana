"use client";

import { useState, useCallback } from "react";
import type { DashboardProject } from "@/store/utils/localStorage";

function formatRelativeTime(timestamp: number | undefined | null): string {
  if (!timestamp) return "Never saved";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatCost(cost: number): string {
  if (cost === 0) return "";
  return `$${cost.toFixed(2)}`;
}

function truncatePath(dirPath: string, maxLen: number = 40): string {
  if (dirPath.length <= maxLen) return dirPath;
  const parts = dirPath.split("/");
  if (parts.length <= 2) return "..." + dirPath.slice(-maxLen);
  return ".../" + parts.slice(-2).join("/");
}

interface ProjectCardProps {
  project: DashboardProject;
  isCurrent: boolean;
  onOpen: (workflowId: string) => void;
  onDelete: (workflowId: string) => void;
}

export function ProjectCard({ project, isCurrent, onOpen, onDelete }: ProjectCardProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (showDeleteConfirm) {
      onDelete(project.workflowId);
      setShowDeleteConfirm(false);
    } else {
      setShowDeleteConfirm(true);
    }
  }, [showDeleteConfirm, onDelete, project.workflowId]);

  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(false);
  }, []);

  return (
    <button
      onClick={() => onOpen(project.workflowId)}
      className={`group relative w-full text-left p-4 rounded-lg border transition-all duration-150 ${
        isCurrent
          ? "border-blue-500/50 bg-blue-500/10 hover:bg-blue-500/15"
          : "border-neutral-700/50 hover:border-neutral-600 hover:bg-neutral-800/40"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-neutral-200 truncate">
              {project.name}
            </h3>
            {isCurrent && (
              <span className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded bg-blue-500/20 text-blue-400">
                Open
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-500 truncate mt-1" title={project.directoryPath}>
            {truncatePath(project.directoryPath)}
          </p>
        </div>

        {/* Delete button */}
        <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {showDeleteConfirm ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={handleDelete}
                className="px-2 py-1 text-[10px] font-medium text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded transition-colors"
              >
                Delete
              </button>
              <button
                onClick={handleCancelDelete}
                className="px-2 py-1 text-[10px] font-medium text-neutral-400 hover:text-neutral-200 bg-neutral-700/50 hover:bg-neutral-700 border border-neutral-600 rounded transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={handleDelete}
              className="p-1 text-neutral-500 hover:text-red-400 hover:bg-neutral-700/50 rounded transition-colors"
              title="Delete project"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-3 mt-2.5 text-[11px] text-neutral-500">
        <span>{formatRelativeTime(project.updatedAt ?? project.lastSavedAt)}</span>
        {(project.nodeCount != null && project.nodeCount > 0) && (
          <>
            <span className="text-neutral-700">·</span>
            <span>{project.nodeCount} nodes</span>
          </>
        )}
        {project.incurredCost > 0 && (
          <>
            <span className="text-neutral-700">·</span>
            <span>{formatCost(project.incurredCost)}</span>
          </>
        )}
      </div>
    </button>
  );
}
