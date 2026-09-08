import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GenerationToasts } from "@/components/GenerationToast";
import {
  GENERATION_TOAST_BATCH_MS,
  GENERATION_TOAST_DURATION_MS,
  useGenerationToast,
} from "@/store/generationToastStore";

const push = (image = "data:image/png;base64,a", model = "nano-banana-pro") =>
  act(() => useGenerationToast.getState().push({ image, model, aspectRatio: "1:1" }));

describe("GenerationToasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    act(() => useGenerationToast.getState().clear());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing until a generation lands", () => {
    const { container } = render(<GenerationToasts />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the preview with the producer's full name", () => {
    render(<GenerationToasts />);
    push();

    expect(screen.getByText("Image generated")).toBeInTheDocument();
    expect(screen.getByText("Nano Banana Pro · 1:1")).toBeInTheDocument();
    expect(document.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,a");
  });

  it("collapses a burst from one producer into a single stacked card", () => {
    render(<GenerationToasts />);
    push("data:image/png;base64,a");
    push("data:image/png;base64,b");
    push("data:image/png;base64,c");

    expect(screen.getAllByTestId("generation-toast")).toHaveLength(1);
    expect(screen.getByText("3 images generated")).toBeInTheDocument();
    expect(document.querySelectorAll("img")).toHaveLength(3);
  });

  it("starts a new card once the batch window has passed", () => {
    render(<GenerationToasts />);
    push("data:image/png;base64,a");
    act(() => vi.advanceTimersByTime(GENERATION_TOAST_BATCH_MS + 1));
    push("data:image/png;base64,b");

    expect(screen.getAllByTestId("generation-toast")).toHaveLength(2);
  });

  it("dismisses itself after the duration", () => {
    render(<GenerationToasts />);
    push();
    expect(screen.getByTestId("generation-toast")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(GENERATION_TOAST_DURATION_MS + 1));
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
  });

  it("dismisses on the close button", () => {
    render(<GenerationToasts />);
    push();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
  });

  it("drags as a history image and dismisses", () => {
    render(<GenerationToasts />);
    push();
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId("generation-toast"), {
      dataTransfer: { setData, effectAllowed: "" },
    });
    expect(setData).toHaveBeenCalledWith("application/history-image", expect.stringContaining("base64,a"));
    expect(screen.queryByTestId("generation-toast")).not.toBeInTheDocument();
  });
});
