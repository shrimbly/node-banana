"use client";

/**
 * The mark Magnific's rows and badges carry: a plain "M", drawn here like
 * the Kie "K", not Magnific's own logo.
 */
export function MagnificMark({
  className = "w-4 h-4",
  label,
}: {
  className?: string;
  /** Set only where the mark stands alone; beside a text label it is decorative. */
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <path d="M3.5 20V4h3.6l4.9 8.3L16.9 4h3.6v16h-3.3V10.1l-4.2 7h-2l-4.2-7V20H3.5z" />
    </svg>
  );
}
