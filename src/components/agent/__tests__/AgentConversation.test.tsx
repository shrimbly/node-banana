/**
 * The transcript's scroller: where it starts and how it follows a reply.
 * use-stick-to-bottom does the scrolling, which jsdom can't lay out, so the
 * test reads the options the transcript gives it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentUIMessage } from "@/lib/agent/types";

const stick = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>>, scrolls: [] as unknown[][] }));

/** The real scroller, with the options it was given and its scrollToBottom calls recorded. */
vi.mock("use-stick-to-bottom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("use-stick-to-bottom")>();
  const { createElement } = await import("react");
  const StickToBottom = Object.assign(
    (props: Parameters<typeof actual.StickToBottom>[0]) => {
      stick.props.push(props as Record<string, unknown>);
      return createElement(actual.StickToBottom, props);
    },
    actual.StickToBottom,
  );
  const recorded = new WeakMap<object, (...args: unknown[]) => unknown>();
  const useStickToBottomContext = () => {
    const context = actual.useStickToBottomContext();
    let scrollToBottom = recorded.get(context.scrollToBottom);
    if (!scrollToBottom) {
      scrollToBottom = (...args: unknown[]) => {
        stick.scrolls.push(args);
        return (context.scrollToBottom as (...inner: unknown[]) => unknown)(...args);
      };
      recorded.set(context.scrollToBottom, scrollToBottom);
    }
    return { ...context, scrollToBottom };
  };
  return { ...actual, StickToBottom, useStickToBottomContext };
});

import { AgentConversation, type AgentConversationProps } from "@/components/agent/AgentConversation";

type Part = AgentUIMessage["parts"][number];
const user = (id: string, text: string): AgentUIMessage => ({ id, role: "user", parts: [{ type: "text", text } as Part] });
const assistant = (id: string, text: string): AgentUIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text, state: "done" } as Part],
});

function props(messages: AgentUIMessage[]): AgentConversationProps {
  return {
    messages,
    busy: false,
    statusLine: null,
    stoppedMessageIds: new Set(),
    error: undefined,
    onRetry: () => {},
    onDismissError: () => {},
    onSignIn: () => {},
  };
}

/** The user asked for less motion, or not. */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: reduce && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} })),
  );
}

const lastOptions = () => stick.props[stick.props.length - 1]!;

describe("AgentConversation scrolling", () => {
  beforeEach(() => {
    stick.props = [];
    stick.scrolls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens at the newest line at once, instead of gliding down from the top", () => {
    stubReducedMotion(false);
    render(<AgentConversation {...props([user("u1", "Make a film"), assistant("a1", "Built it.")])} />);
    expect(lastOptions().initial).toBe("instant");
    // A reply growing under it is followed smoothly.
    expect(lastOptions().resize).toBe("smooth");
  });

  it("follows a reply without animating when the user asked for less motion", () => {
    stubReducedMotion(true);
    render(<AgentConversation {...props([user("u1", "Make a film"), assistant("a1", "Built it.")])} />);
    expect(lastOptions().initial).toBe("instant");
    expect(lastOptions().resize).toBe("instant");
  });

  it("brings the user's own message into view when they send one, even from scrolled up", () => {
    const history = [user("u1", "Make a film"), assistant("a1", "Built it.")];
    const { rerender } = render(<AgentConversation {...props(history)} />);
    // Opening a conversation is not a send.
    expect(stick.scrolls).toEqual([]);

    rerender(<AgentConversation {...props([...history, user("u2", "Make it warmer")])} busy />);
    expect(stick.scrolls).toEqual([["instant"]]);

    // The reply then streams in under it; the scroller follows it by itself.
    const streaming: AgentUIMessage = { id: "a2", role: "assistant", parts: [{ type: "text", text: "Warm", state: "streaming" } as Part] };
    rerender(<AgentConversation {...props([...history, user("u2", "Make it warmer"), streaming])} busy />);
    expect(stick.scrolls).toEqual([["instant"]]);
  });

  it("shows the progress line still, without its sweeping band, under reduced motion", () => {
    stubReducedMotion(true);
    render(<AgentConversation {...props([user("u1", "Make a film")])} busy />);
    const line = screen.getByRole("status").firstElementChild as HTMLElement;
    expect(line).toHaveTextContent(/\S/);
    expect(line.style.backgroundImage).toBe("");
    expect(line.className).toContain("text-ink-3");
  });
});
