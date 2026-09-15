import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CarouselControls, dotWindow } from "../CarouselControls";

describe("CarouselControls", () => {
  it("renders nothing for a single item", () => {
    const { container } = render(<CarouselControls index={0} count={1} onPrev={() => {}} onNext={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows arrows, counter and calls handlers", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<CarouselControls index={1} count={3} onPrev={onPrev} onNext={onNext} />);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Previous image"));
    fireEvent.click(screen.getByTitle("Next image"));
    expect(onPrev).toHaveBeenCalled();
    expect(onNext).toHaveBeenCalled();
  });

  it("uses the noun in titles and disables while loading", () => {
    render(<CarouselControls index={0} count={2} onPrev={() => {}} onNext={() => {}} noun="video" loading />);
    expect(screen.getByTitle("Previous video")).toBeDisabled();
    expect(screen.getByTitle("Next video")).toBeDisabled();
  });

  it("windows the dots to seven around the current index", () => {
    expect(dotWindow(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(dotWindow(0, 20)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(dotWindow(10, 20)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(dotWindow(19, 20)).toEqual([13, 14, 15, 16, 17, 18, 19]);
  });
});
