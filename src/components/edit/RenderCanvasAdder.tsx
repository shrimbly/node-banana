"use client";

import { useEffect } from "react";
import { useAddMediaNode } from "@/hooks/useAddMediaNode";
import { setRenderCanvasAdder } from "./renderEdit";

/**
 * Hands an edit render's "Add to canvas" the open workflow's canvas, which needs React Flow's context. Mounted with
 * the page, not the Edit video view: a render that finishes after the view was left still offers it.
 */
export function RenderCanvasAdder() {
  const addMedia = useAddMediaNode();
  useEffect(() => {
    setRenderCanvasAdder(({ src, filename }) => {
      addMedia({ kind: "video", src, filename });
    });
    return () => setRenderCanvasAdder(null);
  }, [addMedia]);
  return null;
}
