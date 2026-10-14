/**
 * The centre of the canvas the user sees, in screen coordinates. On the GPU canvas that is its host (its
 * painter keeps a hidden React Flow sheet of its own, which a bare `.react-flow` query would find first);
 * elsewhere React Flow's pane. Falls back to the window's centre.
 */
export function getPaneCenter(): { x: number; y: number } {
  const pane = document.querySelector("[data-gpu-canvas]") ?? document.querySelector(".react-flow");
  if (pane) {
    const rect = pane.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}
