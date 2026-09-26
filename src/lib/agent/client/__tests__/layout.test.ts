import { describe, it, expect } from "vitest";
import {
  AGENT_PANEL_EDGE,
  AGENT_PANEL_WIDTH,
  getAgentButtonBottom,
  getAgentPanelFrame,
  getAgentPanelOcclusion,
  getVisibleFlowRect,
  rectContains,
} from "../layout";

describe("agent button and window placement", () => {
  it("stacks the button 8px above the navigator, whatever its height", () => {
    // Navigator with the minimap (198px) and without it (42px), 16px from the edge.
    expect(getAgentButtonBottom({ margin: 16, navigatorHeight: 198 })).toBe(222);
    expect(getAgentButtonBottom({ margin: 16, navigatorHeight: 42 })).toBe(66);
  });

  it("puts the window in the button's place (8px above the navigator), right-aligned with it", () => {
    const frame = getAgentPanelFrame({ buttonRight: 16, buttonBottom: 222, viewportWidth: 1280 });
    expect(frame).toEqual({
      right: 16,
      bottom: 222,
      width: AGENT_PANEL_WIDTH,
      maxHeight: "calc(100vh - 278px)",
    });
  });

  it("narrows on a small viewport rather than running off the left edge", () => {
    for (const viewportWidth of [1280, 756, 600, 420]) {
      const frame = getAgentPanelFrame({ buttonRight: 16, buttonBottom: 66, viewportWidth });
      expect(frame.right).toBe(16);
      expect(frame.right + frame.width, `at ${viewportWidth}px`).toBeLessThanOrEqual(viewportWidth - AGENT_PANEL_EDGE);
    }
    expect(getAgentPanelFrame({ buttonRight: 16, buttonBottom: 66, viewportWidth: 420 }).width).toBe(388);
  });

  it("measures the covered strip from the right edge", () => {
    expect(getAgentPanelOcclusion({ right: 16, width: 400 })).toBe(432);
  });
});

describe("getVisibleFlowRect", () => {
  it("converts the pane to flow coordinates", () => {
    expect(getVisibleFlowRect({ transform: [-200, 100, 2], paneWidth: 1000, paneHeight: 800 })).toEqual({
      x: 100,
      y: -50,
      width: 500,
      height: 400,
      zoom: 2,
    });
  });

  it("leaves out the strip the window covers", () => {
    const rect = getVisibleFlowRect({
      transform: [0, 0, 1],
      paneWidth: 1400,
      paneHeight: 900,
      occludedRight: 431,
    });
    expect(rect.width).toBe(969);
  });

  it("uses the whole pane when the window would leave too little room", () => {
    const rect = getVisibleFlowRect({ transform: [0, 0, 1], paneWidth: 600, paneHeight: 900, occludedRight: 431 });
    expect(rect.width).toBe(600);
  });

  it("guards against a zero zoom", () => {
    expect(getVisibleFlowRect({ transform: [0, 0, 0], paneWidth: 100, paneHeight: 100 }).zoom).toBe(1);
  });
});

describe("rectContains", () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };
  it("is true only when fully inside", () => {
    expect(rectContains(outer, { x: 10, y: 10, width: 50, height: 50 })).toBe(true);
    expect(rectContains(outer, { x: 0, y: 0, width: 100, height: 100 })).toBe(true);
    expect(rectContains(outer, { x: 60, y: 10, width: 50, height: 50 })).toBe(false);
    expect(rectContains(outer, { x: -1, y: 10, width: 5, height: 5 })).toBe(false);
  });
});
