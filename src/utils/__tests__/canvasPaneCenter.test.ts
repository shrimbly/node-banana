import { afterEach, describe, expect, it } from "vitest";
import { getPaneCenter } from "../canvasPaneCenter";

const box = (element: HTMLElement, left: number, top: number, width: number, height: number) => {
  element.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
  return element;
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("getPaneCenter", () => {
  it("measures React Flow's pane on the classic canvas", () => {
    const pane = box(document.createElement("div"), 100, 50, 800, 600);
    pane.className = "react-flow";
    document.body.append(pane);
    expect(getPaneCenter()).toEqual({ x: 500, y: 350 });
  });

  it("measures the GPU canvas's host, not its painter's hidden sheet", () => {
    const host = box(document.createElement("div"), 0, 0, 1200, 800);
    host.setAttribute("data-gpu-canvas", "");
    const sheet = box(document.createElement("div"), 0, 0, 1024, 768);
    sheet.className = "react-flow";
    host.append(sheet);
    document.body.append(host);
    expect(getPaneCenter()).toEqual({ x: 600, y: 400 });
  });
});
