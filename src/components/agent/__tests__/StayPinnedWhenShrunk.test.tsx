/**
 * The transcript stays pinned to its newest line when its box gets shorter
 * (a composer chip appears), unless the user had scrolled up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";

const stick = vi.hoisted(() => ({
  context: {
    scrollRef: { current: null as HTMLElement | null },
    isAtBottom: true,
    escapedFromLock: false,
    scrollToBottom: vi.fn(),
  },
}));

vi.mock("use-stick-to-bottom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("use-stick-to-bottom")>()),
  useStickToBottomContext: () => stick.context,
}));

import { StayPinnedWhenShrunk } from "@/components/agent/AgentConversation";

/** A ResizeObserver the test drives by hand. */
class ManualResizeObserver {
  static instances: ManualResizeObserver[] = [];
  constructor(readonly callback: ResizeObserverCallback) {
    ManualResizeObserver.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let scroller: HTMLDivElement;
let height = 400;
const realResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  ManualResizeObserver.instances = [];
  globalThis.ResizeObserver = ManualResizeObserver as unknown as typeof ResizeObserver;
  scroller = document.createElement("div");
  height = 400;
  Object.defineProperty(scroller, "clientHeight", { get: () => height });
  stick.context.scrollRef.current = scroller;
  stick.context.isAtBottom = true;
  stick.context.escapedFromLock = false;
  stick.context.scrollToBottom.mockReset();
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
});

function resizeTo(next: number) {
  height = next;
  for (const observer of ManualResizeObserver.instances) observer.fire();
}

describe("StayPinnedWhenShrunk", () => {
  it("scrolls back to the newest line when a chip makes the transcript shorter", () => {
    render(<StayPinnedWhenShrunk />);
    resizeTo(370);
    expect(stick.context.scrollToBottom).toHaveBeenCalledWith("instant");
  });

  it("leaves the transcript alone when the user had scrolled up", () => {
    stick.context.isAtBottom = false;
    stick.context.escapedFromLock = true;
    render(<StayPinnedWhenShrunk />);
    resizeTo(370);
    expect(stick.context.scrollToBottom).not.toHaveBeenCalled();
  });

  it("does nothing when the transcript gets taller (the chip went away)", () => {
    render(<StayPinnedWhenShrunk />);
    resizeTo(430);
    expect(stick.context.scrollToBottom).not.toHaveBeenCalled();
  });
});
