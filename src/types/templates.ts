/**
 * Template Types
 *
 * Types for the workflow template gallery system including
 * template metadata, categories, and preview information.
 */

import { WorkflowFile } from "@/store/workflowStore";

/** Template category for filtering */
export type TemplateCategory =
  | "all"
  | "product"
  | "portrait"
  | "style"
  | "composite"
  | "video"
  | "community";

/** Template source - built-in preset or community contributed */
export type TemplateSource = "preset" | "community";

/** Template metadata for gallery display */
export interface TemplateMeta {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  source: TemplateSource;
  icon?: string;
  author?: string;
  nodeCount?: number;
  tags?: string[];
}

/** Template preview data */
export interface TemplatePreview {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
  nodeTypes: string[];
  previewNodes?: Array<{
    type: string;
    label: string;
  }>;
}

/** Gallery filter state */
export interface TemplateGalleryFilters {
  search: string;
  category: TemplateCategory;
  source: TemplateSource | "all";
}
