"use client";

import { useMemo } from "react";
import type { AssetFacets } from "@/lib/assets/types";
import { RadioMenu, type RadioMenuOption } from "./RadioMenu";

const MENU_WIDTH = 220;
const ALL_PROJECTS = "All projects";

/**
 * "All projects ▾", in the library's filter popover: all of them, or one of
 * the projects that hold assets (the library's facets, as the Assets rail
 * lists them), with "Not in a project" last. The filter value is the
 * project's folder, "" for not in a project, null for all. A select-like
 * field as wide as its row; the menu opens leftward from its right edge, so
 * it stays over the library.
 */
export function ProjectMenu({
  value,
  projects,
  onChange,
}: {
  value: string | null;
  projects: AssetFacets["projects"];
  onChange: (project: string | null) => void;
}) {
  const options = useMemo<RadioMenuOption<string | null>[]>(
    () => [{ value: null, label: ALL_PROJECTS }, ...projects.map((p) => ({ value: p.path ?? "", label: p.name }))],
    [projects],
  );
  // A project chosen before the facets arrive still names itself
  const current = options.find((o) => o.value === value)?.label ?? (value === "" ? "Not in a project" : ALL_PROJECTS);
  return (
    <RadioMenu
      label={`Project: ${current}`}
      buttonLabel={<span className="min-w-0 flex-1 truncate text-left">{current}</span>}
      value={value}
      options={options}
      onChange={onChange}
      width={MENU_WIDTH}
      align="end"
      // A long project name truncates before the row runs out
      className="h-7 w-full min-w-0 shrink rounded-md bg-edit-field pl-2.5 pr-1.5 text-neutral-200 hover:bg-edit-pressed aria-expanded:bg-edit-pressed"
    />
  );
}
