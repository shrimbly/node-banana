import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { toast } from "sonner";
import {
  GENERATION_TOAST_DURATION_MS,
  GenerationToaster,
  clearGenerationToasts,
  pushGenerationToast,
} from "@/components/GenerationToast";
import { useAssetStore } from "@/store/assetStore";

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

  it.each(["assets", "chat"] as const)("stays quiet while the %s view shows (it shows arrivals itself)", (view) => {
    useAssetStore.setState({ appView: view });
    render(<GenerationToaster />);
    push();
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
    useAssetStore.setState({ appView: "canvas" });
    push();
    expect(screen.getByTestId("generation-toast")).toBeInTheDocument();
  });

  it("clears only generation cards, leaving another toast (the library's first-run hint) up", () => {
    render(<GenerationToaster />);
    push();
    act(() => {
      toast.custom(() => <div data-testid="other-toast">Saved to Pictures › Node Banana</div>, { id: "other", duration: 60_000 });
      vi.advanceTimersByTime(0);
    });
    act(() => clearGenerationToasts());
    settle();
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
    expect(screen.getByTestId("other-toast")).toBeInTheDocument();
    act(() => toast.dismiss("other"));
    settle();
  });

  it("gives every generation its own card, bursts included", () => {
    render(<GenerationToaster />);
    push("data:image/png;base64,a");
    push("data:image/png;base64,b");
    push("data:image/png;base64,c", "nano-banana");

    expect(screen.getAllByTestId("generation-toast")).toHaveLength(3);
    expect(screen.getAllByText("Image generated")).toHaveLength(3);
    expect(document.querySelectorAll("img")).toHaveLength(3);
  });

  it("dismissing one card leaves the others", () => {
    render(<GenerationToaster />);
    push("data:image/png;base64,a");
    push("data:image/png;base64,b");
    fireEvent.click(screen.getAllByLabelText("Dismiss")[0]);
    settle();
    expect(screen.getAllByTestId("generation-toast")).toHaveLength(1);
  });

  it("dismisses itself after the duration", () => {
    render(<GenerationToaster />);
    push();
    expect(screen.getByTestId("generation-toast")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(GENERATION_TOAST_DURATION_MS + 1));
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
