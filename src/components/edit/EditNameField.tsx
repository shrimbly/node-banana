"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { inputClass } from "@/components/ui/Controls";

/**
 * An edit's name, renamed in place: a button showing it, which a click or
 * Enter (or the menu's Rename, through `editing`) turns into a field with the
 * name selected. Enter or leaving the field commits; Escape puts the name
 * back. A refused name ("Another edit has that name") keeps the field open
 * with the note under it. Its focus rings are the editor's white, not the
 * app's blue. The media pane renames its items with it too (`maxLength`,
 * `inputLabel`).
 */
export function EditNameField({
  name,
  editing,
  onEditingChange,
  onCommit,
  error,
  className,
  buttonClassName,
  maxLength = 80,
  inputLabel = "Edit name",
}: {
  name: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** false: refused, keep the field open. */
  onCommit: (name: string) => Promise<boolean>;
  error: string | null;
  className?: string;
  buttonClassName?: string;
  maxLength?: number;
  /** The field's accessible name. */
  inputLabel?: string;
}) {
  if (!editing) {
    return (
      <button
        type="button"
        title="Rename"
        className={cn(
          "min-w-0 max-w-[200px] truncate rounded-md px-1.5 py-0.5 text-left text-[13px] font-semibold text-neutral-100 hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          buttonClassName,
        )}
        onClick={() => onEditingChange(true)}
      >
        {name}
      </button>
    );
  }
  return (
    <NameInput
      name={name}
      onEditingChange={onEditingChange}
      onCommit={onCommit}
      error={error}
      className={className}
      maxLength={maxLength}
      label={inputLabel}
    />
  );
}

/** The field, from the name it opened with. */
function NameInput({
  name,
  onEditingChange,
  onCommit,
  error,
  className,
  maxLength,
  label,
}: {
  name: string;
  onEditingChange: (editing: boolean) => void;
  onCommit: (name: string) => Promise<boolean>;
  error: string | null;
  className?: string;
  maxLength: number;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(name);
  // A commit is sent once, whether Enter or the blur that follows it got there first; Escape sends none
  const settled = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const commit = async () => {
    if (settled.current) return;
    settled.current = true;
    const ok = await onCommit(value);
    if (ok) onEditingChange(false);
    else settled.current = false;
  };

  return (
    <div className={cn("relative min-w-0", className)}>
      <input
        ref={inputRef}
        aria-label={label}
        aria-invalid={error !== null || undefined}
        value={value}
        maxLength={maxLength}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            settled.current = true;
            onEditingChange(false);
          }
        }}
        onBlur={() => void commit()}
        className={cn(inputClass, "h-7 w-[200px] px-2 text-[13px] font-semibold focus-visible:ring-white/40")}
      />
      {error && (
        <div role="alert" className="absolute left-0 top-full z-20 mt-1 whitespace-nowrap rounded-md bg-neutral-950 px-2 py-1 text-[11px] text-red-400 shadow-menu">
          {error}
        </div>
      )}
    </div>
  );
}
