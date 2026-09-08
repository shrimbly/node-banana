import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  GENERATION_TOAST_BATCH_MS,
  GENERATION_TOAST_DURATION_MS,
  GenerationToaster,
  clearGenerationToasts,
  pushGenerationToast,
} from "@/components/GenerationToast";

/** Sonner dismisses through two animation frames (16ms each under fake timers). */
const DISMISS_FRAMES_MS = 40;
/** Then it keeps the card mounted this long for its exit transition. */
const UNMOUNT_MS = 200;

// Sonner hands new toasts to the Toaster on a zero-delay timeout; flush it.
const push = (image = "data:image/png;base64,a", model = "nano-banana-pro") =>
  act(() => {
    pushGenerationToast({ image, model, aspectRatio: "1:1" });
    vi.advanceTimersByTime(0);
  });

// Two acts: the unmount timer is only scheduled once React commits the dismissal.
const settle = () => {
  act(() => vi.advanceTimersByTime(DISMISS_FRAMES_MS));
  act(() => vi.advanceTimersByTime(UNMOUNT_MS + 1));
};

describe("GenerationToaster", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "requestAnimationFrame",
        "cancelAnimationFrame",
      ],
    });
    act(() => clearGenerationToasts());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing until a generation lands", () => {
    render(<GenerationToaster />);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
  });

  it("shows the preview with the producer's full name", () => {
    render(<GenerationToaster />);
    push();

    expect(screen.getByText("Image generated")).toBeInTheDocument();
    expect(screen.getByText("Nano Banana Pro · 1:1")).toBeInTheDocument();
    expect(document.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,a");
  });

  it("collapses a burst from one producer into a single stacked card", () => {
    render(<GenerationToaster />);
    push("data:image/png;base64,a");
    push("data:image/png;base64,b");
    push("data:image/png;base64,c");

    expect(screen.getAllByTestId("generation-toast")).toHaveLength(1);
    expect(screen.getByText("3 images generated")).toBeInTheDocument();
    expect(document.querySelectorAll("img")).toHaveLength(3);
  });

  it("starts a new card once the batch window has passed", () => {
    render(<GenerationToaster />);
    push("data:image/png;base64,a");
    act(() => vi.advanceTimersByTime(GENERATION_TOAST_BATCH_MS + 1));
    push("data:image/png;base64,b");

    expect(screen.getAllByTestId("generation-toast")).toHaveLength(2);
  });

  it("starts a new card for a different producer", () => {
    render(<GenerationToaster />);
    push("data:image/png;base64,a", "nano-banana-pro");
    push("data:image/png;base64,b", "nano-banana");

    expect(screen.getAllByTestId("generation-toast")).toHaveLength(2);
  });

  it("dismisses itself after the duration", () => {
    render(<GenerationToaster />);
    push();
    expect(screen.getByTestId("generation-toast")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(GENERATION_TOAST_DURATION_MS + 1));
    settle();
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
  });

  it("restarts the countdown when a batch extends the card", () => {
    render(<GenerationToaster />);
    push("data:image/png;base64,a");
    act(() => vi.advanceTimersByTime(GENERATION_TOAST_BATCH_MS - 1));
    push("data:image/png;base64,b");

    act(() => vi.advanceTimersByTime(GENERATION_TOAST_DURATION_MS - GENERATION_TOAST_BATCH_MS + 1));
    settle();
    expect(screen.getByTestId("generation-toast")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(GENERATION_TOAST_DURATION_MS));
    settle();
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
  });

  it("dismisses on the close button", () => {
    render(<GenerationToaster />);
    push();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    settle();
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
  });

  it("does not extend a card the user has dismissed", () => {
    render(<GenerationToaster />);
    push("data:image/png;base64,a");
    fireEvent.click(screen.getByLabelText("Dismiss"));
    settle();
    push("data:image/png;base64,b");

    expect(screen.getAllByTestId("generation-toast")).toHaveLength(1);
    expect(screen.getByText("Image generated")).toBeInTheDocument();
  });

  it("drags as a history image and dismisses", () => {
    render(<GenerationToaster />);
    push();
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId("generation-toast"), {
      dataTransfer: { setData, effectAllowed: "" },
    });
    settle();
    expect(setData).toHaveBeenCalledWith("application/history-image", expect.stringContaining("base64,a"));
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
  });
});
