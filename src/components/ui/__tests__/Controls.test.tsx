import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Segmented } from "../Controls";

const OPTIONS = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
];

describe("Segmented", () => {
  it("shares the track's width at 28px by default", () => {
    render(<Segmented label="Loop" options={OPTIONS} value="1" onChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "1×" });
    expect(button).toHaveClass("flex-1", "h-7");
  });

  it("sizes the buttons to their labels at 24px when small", () => {
    render(<Segmented size="sm" label="Loop" options={OPTIONS} value="1" onChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "2×" });
    expect(button).toHaveClass("h-6", "px-2.5");
    expect(button).not.toHaveClass("flex-1");
    expect(button).not.toHaveClass("h-7");
  });
});
