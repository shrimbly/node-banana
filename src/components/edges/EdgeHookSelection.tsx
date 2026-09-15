"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { crossesEdge, FORK_HOTSPOT, FORK_PATHS, FORK_SIZE, type Point } from "@/lib/edges/hook";

/** Hold H and sweep the rendered noodles; nodes never participate in this gesture. */
export function EdgeHookSelection({ canvas, disabled }: { canvas: RefObject<HTMLDivElement | null>; disabled: boolean }) {
  const [held, setHeld] = useState(false);
  const [count, setCount] = useState(0);
  // The fork follows the pointer as an element, so it can ease between sizes;
  // it is moved directly, outside React, on every pointer event
  const fork = useRef<HTMLDivElement | null>(null);
  const placeFork = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = fork.current;
    if (!el) return;
    const rect = event.currentTarget.getBoundingClientRect();
    el.style.transform = `translate(${event.clientX - rect.left - FORK_HOTSPOT.x}px, ${event.clientY - rect.top - FORK_HOTSPOT.y}px)`;
    el.style.opacity = "1";
  };
  const { screenToFlowPosition } = useReactFlow();
  const gesture = useRef<{ last: Point; ids: Set<string>; paths: { id: string; points: Point[] }[] } | null>(null);
  const finish = useRef<(cancel?: boolean) => void>(() => {});
  finish.current = (cancel = false) => {
    const sweep = gesture.current;
    gesture.current = null;
    if (!sweep) return;
    const store = useWorkflowStore.getState();
    // The noodles drop where the pointer is: as a bundle with its handle, or back to their own routes
    store.setHookDrag(null);
    if (!cancel) store.hookEdges([...sweep.ids], screenToFlowPosition(sweep.last));
    else store.onEdgesChange([...sweep.ids].map((id) => ({ type: "select", id, selected: false })));
    setCount(0);
  };

  useEffect(() => {
    if (disabled) { setHeld(false); finish.current(true); return; }
    const down = (event: KeyboardEvent) => {
      if (event.key === "Escape") { finish.current(true); setHeld(false); return; }
      if (event.key.toLowerCase() !== "h" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], .nokey')) return;
      event.preventDefault();
      setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "h") return;
      finish.current();
      setHeld(false);
    };
    const blur = () => { finish.current(true); setHeld(false); };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      finish.current(true);
    };
  }, [disabled]);

  if (!held || disabled) return null;

  const collect = (point: Point) => {
    const sweep = gesture.current;
    if (!sweep) return;
    const added = new Set<string>();
    for (const path of sweep.paths) {
      if (!sweep.ids.has(path.id) && crossesEdge(sweep.last, point, path.points)) added.add(path.id);
    }
    sweep.last = point;
    if (added.size) {
      added.forEach((id) => sweep.ids.add(id));
      useWorkflowStore.getState().onEdgesChange([...added].map((id) => ({ type: "select", id, selected: true })));
      setCount(sweep.ids.size);
    }
    // Everything caught so far is carried along on the fork
    if (sweep.ids.size) useWorkflowStore.getState().setHookDrag({ ...screenToFlowPosition(point), edgeIds: [...sweep.ids] });
  };

  return (
    <div
      data-testid="edge-hook-selection"
      className="absolute inset-0 z-[3000] nodrag nopan touch-none"
      style={{ cursor: "none" }}
      onPointerEnter={placeFork}
      onPointerLeave={() => { if (fork.current) fork.current.style.opacity = "0"; }}
      onPointerDown={(event) => {
        placeFork(event);
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const store = useWorkflowStore.getState();
        store.onNodesChange(store.nodes.filter((n) => n.selected).map((n) => ({ type: "select", id: n.id, selected: false })));
        store.onEdgesChange(store.edges.filter((e) => e.selected).map((e) => ({ type: "select", id: e.id, selected: false })));
        const eligible = new Set(store.edges.filter((e) => !e.hidden && !e.data?.hidden && e.type !== "reference").map((e) => e.id));
        const paths: { id: string; points: Point[] }[] = [];
        canvas.current?.querySelectorAll<SVGPathElement>(".react-flow__edge .react-flow__edge-path").forEach((path) => {
          const id = path.closest(".react-flow__edge")?.getAttribute("data-id");
          const matrix = path.getScreenCTM();
          if (!id || !eligible.has(id) || !matrix) return;
          const length = path.getTotalLength();
          const steps = Math.max(1, Math.ceil(length * Math.hypot(matrix.a, matrix.b) / 5));
          const points = Array.from({ length: steps + 1 }, (_, i) => {
            const p = path.getPointAtLength(length * i / steps);
            return { x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f };
          });
          paths.push({ id, points });
        });
        const point = { x: event.clientX, y: event.clientY };
        gesture.current = { last: point, ids: new Set(), paths };
        collect(point);
      }}
      onPointerMove={(event) => {
        placeFork(event);
        collect({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={(event) => {
        collect({ x: event.clientX, y: event.clientY });
        finish.current();
      }}
      onPointerCancel={() => finish.current(true)}
      onContextMenu={(event) => event.preventDefault()}
    >
      {/* The fork: hidden until the pointer is over the canvas, tightening to 0.95 while it carries a catch */}
      <div
        ref={fork}
        data-testid="edge-hook-cursor"
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 opacity-0"
        style={{ width: FORK_SIZE, height: FORK_SIZE, willChange: "transform" }}
      >
        <svg
          width={FORK_SIZE}
          height={FORK_SIZE}
          viewBox="0 0 24 24"
          fill="none"
          style={{
            display: "block",
            transform: `scale(${count ? 0.95 : 1})`,
            transformOrigin: `${FORK_HOTSPOT.x}px ${FORK_HOTSPOT.y}px`,
            transition: "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)",
          }}
        >
          {FORK_PATHS.map((d) => (
            <path key={`halo-${d}`} d={d} stroke="#101820" strokeOpacity={0.9} strokeWidth={4.5} strokeLinecap="round" strokeLinejoin="round" />
          ))}
          {FORK_PATHS.map((d) => (
            <path key={d} d={d} stroke="#e5e5e5" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
      </div>
      <div role="status" className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-controls border border-chrome-border bg-card px-3 py-1.5 text-[11px] text-neutral-300 pointer-events-none">
        {count ? `${count} connections on the fork · release to bundle here` : "Drag across connections to bundle · Esc to cancel"}
      </div>
    </div>
  );
}
