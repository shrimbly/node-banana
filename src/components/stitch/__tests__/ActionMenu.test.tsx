import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MoreMenu, type ActionMenuEntry } from "../ActionMenu";

const open = () => {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  return screen.getByRole("menu", { name: "More" });
};

describe("MoreMenu", () => {
  it("with every row off, takes focus itself, so Escape and Tab still close it", () => {
    render(<MoreMenu label="More" entries={[{ kind: "item", label: "Nothing", onSelect: vi.fn(), disabled: true }]} />);
    const trigger = screen.getByRole("button", { name: "More" });
    let menu = open();
    expect(menu).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    menu = open();
    fireEvent.keyDown(menu, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("rings a row with keyboard focus in white, over its faint fill, and keeps a row's value readable when it is lit", () => {
    render(
      <MoreMenu
        label="More"
        entries={[
          { kind: "item", label: "Plain", onSelect: vi.fn() },
          {
            kind: "submenu",
            label: "Loop",
            value: "Off",
            entries: [{ kind: "radio", label: "Off", checked: true, onSelect: vi.fn() }],
          },
        ]}
      />,
    );
    const menu = open();
    for (const row of within(menu).getAllByRole("menuitem")) {
      expect(row).toHaveClass("focus-visible:bg-white/6", "focus-visible:ring-2", "focus-visible:ring-inset", "focus-visible:ring-white/40");
    }
    // neutral-400, not ink-3, which falls under 4.5:1 on a lit row
    expect(within(menu).getByText("Off")).toHaveClass("text-neutral-400");
    expect(within(menu).getByText("Off")).not.toHaveClass("text-ink-3");
  });

  it("gives focus back to ⋯ after a pick, unless the pick put it somewhere", () => {
    function Harness() {
      const [field, setField] = useState(false);
      return (
        <>
          <MoreMenu
            label="More"
            entries={[
              { kind: "item", label: "Plain", onSelect: vi.fn() },
              { kind: "item", label: "Field", onSelect: () => setField(true) },
            ]}
          />
          {field && <input aria-label="Field" autoFocus />}
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(within(open()).getByRole("menuitem", { name: "Plain" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    fireEvent.click(within(open()).getByRole("menuitem", { name: "Field" }));
    expect(screen.getByRole("textbox", { name: "Field" })).toHaveFocus();
  });

  it("draws a submenu's row as the boards draw Loop, its name and value alone, and opens its radios beside the menu", () => {
    const onSelect = vi.fn();
    const entries: ActionMenuEntry[] = [
      { kind: "item", label: "First", onSelect: vi.fn() },
      {
        kind: "submenu",
        label: "Count",
        value: "One",
        footer: "A note",
        entries: [
          { kind: "radio", label: "One", checked: true, onSelect: vi.fn() },
          { kind: "radio", label: "Two", checked: false, onSelect },
        ],
      },
    ];
    render(<MoreMenu label="More" entries={entries} />);
    const menu = open();
    const [first, row] = within(menu).getAllByRole("menuitem");
    expect(row).toHaveAccessibleName("Count: One");
    expect(row).toHaveAttribute("aria-haspopup", "menu");
    // "Count" and "One", nothing else: no chevron
    expect(row.querySelector("svg")).toBeNull();
    expect(Array.from(row.children, (el) => el.textContent)).toEqual(["Count", "One"]);
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(row).toHaveFocus();
    // → opens it, its first radio focused, with its note as its description
    fireEvent.keyDown(row, { key: "ArrowRight" });
    const sub = screen.getByRole("menu", { name: "Count" });
    expect(sub).toHaveAccessibleDescription("A note");
    const [one, two] = within(sub).getAllByRole("menuitemradio");
    expect(one).toHaveFocus();
    expect(one).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(one, { key: "ArrowDown" });
    expect(two).toHaveFocus();
    fireEvent.click(two);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
