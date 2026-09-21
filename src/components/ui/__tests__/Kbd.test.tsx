import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Kbd, KbdGroup, splitKeys } from "@/components/ui/Kbd";

describe("splitKeys", () => {
  it("peels modifier glyphs off a compact shortcut", () => {
    expect(splitKeys("⇧G")).toEqual(["⇧", "G"]);
    expect(splitKeys("⌘⇧Z")).toEqual(["⌘", "⇧", "Z"]);
  });

  it("splits a run of glyphs into one key each", () => {
    expect(splitKeys("↑↓")).toEqual(["↑", "↓"]);
    expect(splitKeys("⌘↵")).toEqual(["⌘", "↵"]);
  });

  it("splits on plus and keeps word keys whole", () => {
    expect(splitKeys("Ctrl+K")).toEqual(["Ctrl", "K"]);
    expect(splitKeys("Ctrl↵")).toEqual(["Ctrl↵"]);
  });

  it("leaves a single key and a non-key label alone", () => {
    expect(splitKeys("?")).toEqual(["?"]);
    expect(splitKeys("⇧")).toEqual(["⇧"]);
    expect(splitKeys("Hold H")).toEqual(["Hold H"]);
  });
});

describe("Kbd", () => {
  it("draws known key names as their symbol", () => {
    render(
      <>
        <Kbd>Shift</Kbd>
        <Kbd>Enter</Kbd>
        <Kbd>Ctrl</Kbd>
      </>
    );
    expect(screen.getByText("⇧")).toBeInTheDocument();
    expect(screen.getByText("↵")).toBeInTheDocument();
    expect(screen.getByText("Ctrl")).toBeInTheDocument();
  });
});

describe("KbdGroup", () => {
  it("renders one cap per key from a compact string", () => {
    const { container } = render(<KbdGroup keys="⇧G" />);
    const caps = container.querySelectorAll("kbd");
    expect(caps).toHaveLength(2);
    expect(container).toHaveTextContent("⇧G");
  });

  it("renders an array as given", () => {
    const { container } = render(<KbdGroup keys={["⌘", "Shift", "Z"]} />);
    expect([...container.querySelectorAll("kbd")].map((cap) => cap.textContent)).toEqual(["⌘", "⇧", "Z"]);
  });
});
