// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { defaultCanvasNavigationSettings, type CanvasNavigationSettings } from "@/types/canvas";
import { holdOverScrollArea, sceneWheel, type SceneWheelOptions } from "../wheel";
import { zoomPath } from "../viewPath";

function wheel(init: WheelEventInit, target: Element = document.body) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

const altScroll: CanvasNavigationSettings = defaultCanvasNavigationSettings;
const options = (mac: boolean, more: Partial<SceneWheelOptions> = {}): SceneWheelOptions => ({ settings: altScroll, zoomOnPinch: true, wrapperWheel: true, mac, ...more });

describe("sceneWheel", () => {
  it("pinches about the pointer by React Flow's d3 delta", () => {
    expect(sceneWheel(wheel({ ctrlKey: true, deltaY: -10 }), options(true))).toEqual({ type: "zoom", factor: 2 ** 0.2, about: "pointer" });
    expect(sceneWheel(wheel({ ctrlKey: true, deltaY: -10 }), options(false))).toEqual({ type: "zoom", factor: 2 ** 0.02, about: "pointer" });
  });

  it("steps the zoom 1.2x about the centre with the zoom modifier, whatever the delta", () => {
    expect(sceneWheel(wheel({ altKey: true, deltaY: -3 }), options(true))).toEqual({ type: "zoom", factor: 1.2, about: "centre" });
    expect(sceneWheel(wheel({ altKey: true, deltaY: 400 }), options(false))).toEqual({ type: "zoom", factor: 1 / 1.2, about: "centre" });
  });

  it("pans a macOS trackpad, and leaves a mouse wheel or any plain wheel elsewhere alone", () => {
    expect(sceneWheel(wheel({ deltaX: 4, deltaY: 7 }), options(true))).toEqual({ type: "pan", dx: 4, dy: 7 });
    expect(sceneWheel(wheel({ deltaY: 120 }), options(true))).toBeNull();
    expect(sceneWheel(wheel({ deltaY: 7 }), options(false))).toBeNull();
  });

  it("lets an inner area that can scroll keep the wheel; one that cannot still pans", () => {
    document.body.innerHTML = `<div class="react-flow"><textarea id="field"></textarea></div>`;
    const field = document.getElementById("field") as HTMLTextAreaElement;
    expect(sceneWheel(wheel({ deltaY: 7 }, field), options(true))).toEqual({ type: "pan", dx: 0, dy: 7 });
    Object.defineProperties(field, { scrollHeight: { value: 300 }, clientHeight: { value: 100 } });
    field.style.overflowY = "auto";
    expect(sceneWheel(wheel({ deltaY: 7 }, field), options(true))).toBeNull();
  });

  it("over .nowheel a pinch skips the pointer zoom, and never zooms the page", () => {
    document.body.innerHTML = `<div class="react-flow"><div class="nowheel" id="area"></div></div>`;
    const area = document.getElementById("area")!;
    expect(sceneWheel(wheel({ ctrlKey: true, deltaY: -10 }, area), options(true))).toEqual({ type: "zoom", factor: 1.2, about: "centre" });
    Object.defineProperties(area, { scrollHeight: { value: 300 }, clientHeight: { value: 100 }, scrollTop: { value: 50 } });
    area.style.overflowY = "auto";
    expect(sceneWheel(wheel({ ctrlKey: true, deltaY: -10 }, area), options(true))).toEqual({ type: "block" });
  });

  it("the Meta key zooms about the pointer on macOS (React Flow's zoom activation key)", () => {
    expect(sceneWheel(wheel({ metaKey: true, deltaY: -10 }), options(true))).toEqual({ type: "zoom", factor: 2 ** 0.02, about: "pointer" });
  });

  it("with the pan key held, pans on scroll at half speed and never zooms but for a pinch (React Flow's panOnScroll)", () => {
    const space = (mac: boolean) => options(mac, { settings: { ...altScroll, zoomMode: "scroll" }, panKey: true });
    expect(sceneWheel(wheel({ deltaX: 4, deltaY: 120 }), space(true))).toEqual({ type: "pan", dx: 2, dy: 60 });
    expect(sceneWheel(wheel({ deltaY: 3, deltaMode: 1 }), space(false))).toEqual({ type: "pan", dx: 0, dy: 30 });
    // Shift sends the wheel sideways off the Mac.
    expect(sceneWheel(wheel({ deltaY: 10, shiftKey: true }), space(false))).toEqual({ type: "pan", dx: 5, dy: 0 });
    expect(sceneWheel(wheel({ altKey: true, deltaY: 10 }), space(true))).toEqual({ type: "pan", dx: 0, dy: 5 });
    expect(sceneWheel(wheel({ ctrlKey: true, deltaY: -10 }), space(true))).toEqual({ type: "zoom", factor: 2 ** 0.2, about: "pointer" });
    // The zoom activation key (Meta on macOS, Control elsewhere) turns panOnScroll off.
    expect(sceneWheel(wheel({ metaKey: true, deltaY: -10 }), space(true))).toEqual({ type: "zoom", factor: 2 ** 0.02, about: "pointer" });
    expect(sceneWheel(wheel({ ctrlKey: true, deltaY: -10 }), space(false))).toEqual({ type: "zoom", factor: 2 ** 0.02, about: "pointer" });
  });

  it("over chrome beside the pane, only the wrapper's handler acts: a pinch steps about the centre", () => {
    expect(sceneWheel(wheel({ ctrlKey: true, deltaY: -10 }), options(true, { pane: false }))).toEqual({ type: "zoom", factor: 1.2, about: "centre" });
    expect(sceneWheel(wheel({ metaKey: true, deltaY: -10 }), options(true, { pane: false, settings: { ...altScroll, zoomMode: "ctrlScroll" } }))).toEqual({ type: "zoom", factor: 1.2, about: "centre" });
    expect(sceneWheel(wheel({ deltaX: 4, deltaY: 7 }), options(true, { pane: false, panKey: true }))).toEqual({ type: "pan", dx: 4, dy: 7 });
    expect(sceneWheel(wheel({ deltaX: 4, deltaY: 7 }), options(true, { pane: false, wrapperWheel: false }))).toBeNull();
  });

  it("in the tutorial a pinch steps about the centre (zoomOnPinch off)", () => {
    expect(sceneWheel(wheel({ ctrlKey: true, deltaY: 10 }), options(false, { zoomOnPinch: false }))).toEqual({ type: "zoom", factor: 1 / 1.2, about: "centre" });
  });
});

describe("zoomPath", () => {
  it("starts and ends on the two views, keeping the pane centre on a straight path", () => {
    const from = { x: 0, y: 0, zoom: 1 }, to = { x: -500, y: 200, zoom: 0.5 };
    const path = zoomPath(from, to, 800, 600);
    const start = path(0);
    expect(start.x).toBeCloseTo(0);
    expect(start.y).toBeCloseTo(0);
    expect(start.zoom).toBeCloseTo(1);
    expect(path(1)).toEqual(to);
    const mid = path(0.5);
    expect(mid.zoom).toBeLessThan(1);
    expect(Number.isFinite(mid.x) && Number.isFinite(mid.y)).toBe(true);
  });

  it("zooms in place when only the zoom changes", () => {
    const path = zoomPath({ x: 0, y: 0, zoom: 1 }, { x: 200, y: 150, zoom: 0.5 }, 800, 600);
    const mid = path(0.5);
    // The pane centre (400, 300) stays on flow point (400, 300).
    expect((400 - mid.x) / mid.zoom).toBeCloseTo(400);
    expect((300 - mid.y) / mid.zoom).toBeCloseTo(300);
  });
});

describe("holdOverScrollArea", () => {
  const textarea = { nowheel: false }, list = { nowheel: true };
  const pinch = { type: "zoom", factor: 1.1, about: "pointer" } as const;

  it("holds a pan or a centre step over a painted area that scrolls, and leaves the rest", () => {
    expect(holdOverScrollArea({ type: "pan", dx: 0, dy: 7 }, textarea)).toEqual({ type: "block" });
    expect(holdOverScrollArea({ type: "zoom", factor: 1.2, about: "centre" }, textarea)).toEqual({ type: "block" });
    expect(holdOverScrollArea({ type: "pan", dx: 0, dy: 7 }, null)).toEqual({ type: "pan", dx: 0, dy: 7 });
    expect(holdOverScrollArea(null, textarea)).toBeNull();
  });

  it("lets a pinch zoom over a textarea, not over a .nowheel area", () => {
    expect(holdOverScrollArea(pinch, textarea)).toBe(pinch);
    expect(holdOverScrollArea(pinch, list)).toEqual({ type: "block" });
  });
});
