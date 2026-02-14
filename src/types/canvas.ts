/**
 * Canvas Navigation Types
 *
 * Defines types for canvas navigation and interaction preferences.
 */

export type PanMode = "space" | "middleMouse" | "always";
export type ZoomMode = "scroll" | "altScroll" | "ctrlScroll";
export type SelectionMode = "click" | "altDrag" | "shiftDrag";

export interface CanvasNavigationSettings {
  panMode: PanMode;
  zoomMode: ZoomMode;
  selectionMode: SelectionMode;
}

export const defaultCanvasNavigationSettings: CanvasNavigationSettings = {
  panMode: "space",
  zoomMode: "altScroll",
  selectionMode: "click",
};
