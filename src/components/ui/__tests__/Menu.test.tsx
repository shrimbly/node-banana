import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  MenuSurface,
  MenuHeader,
  MenuSectionLabel,
  MenuList,
  MenuItem,
  MenuFooter,
  MenuHint,
  MenuDivider,
  MenuIconButton,
  MenuBarLabel,
} from "../Menu";

describe("Menu", () => {
  it("renders a list menu with its rows", () => {
    const onSelect = vi.fn();
    render(
      <MenuSurface role="menu" aria-label="Add node">
        <MenuHeader>
          <MenuSectionLabel>Add image node</MenuSectionLabel>
        </MenuHeader>
        <MenuList>
          <MenuItem role="menuitem" selected onClick={onSelect}>Annotate</MenuItem>
          <MenuItem role="menuitem" disabled>Generate Image</MenuItem>
        </MenuList>
        <MenuFooter>
          <MenuHint keys="↑↓">navigate</MenuHint>
        </MenuFooter>
      </MenuSurface>
    );
    const menu = screen.getByRole("menu", { name: "Add node" });
    expect(menu.className).toContain("fixed");
    fireEvent.click(screen.getByText("Annotate"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Generate Image")).toBeDisabled();
    expect(screen.getByText("Add image node")).toBeInTheDocument();
    expect(screen.getByText("navigate")).toBeInTheDocument();
  });

  it("renders a bar menu anchored in place when not floating", () => {
    render(
      <MenuSurface variant="bar" floating={false} data-testid="bar">
        <MenuBarLabel>3</MenuBarLabel>
        <MenuIconButton aria-label="Hide" />
        <MenuDivider variant="bar" />
        <MenuIconButton aria-label="Remove" disabled />
      </MenuSurface>
    );
    const bar = screen.getByTestId("bar");
    expect(bar.className).not.toContain("fixed");
    expect(screen.getByLabelText("Hide")).toBeEnabled();
    expect(screen.getByLabelText("Remove")).toBeDisabled();
  });

  it("lets a caller's classes override the surface defaults", () => {
    render(<MenuSurface data-testid="m" className="min-w-[220px]" />);
    const cls = screen.getByTestId("m").className;
    expect(cls).toContain("min-w-[220px]");
    expect(cls).not.toContain("min-w-[160px]");
  });
});
