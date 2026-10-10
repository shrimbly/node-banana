/**
 * A selector that recomputes only when one of its inputs changes, compared
 * by identity, and otherwise hands back its last result. A component's
 * selectors run on every store update, a drag frame included; one that reads
 * only the edges, or only two nodes, can skip the work and give useShallow
 * the same object, whose compare then ends at its first check.
 *
 * Create one per component instance (in a useMemo keyed by what `compute`
 * closes over), since it remembers a single previous result.
 */
export function lastResult<S, T>(inputs: (state: S) => readonly unknown[], compute: (state: S) => T): (state: S) => T {
  let previousInputs: readonly unknown[] | null = null;
  let previous: T;
  return (state) => {
    const next = inputs(state);
    if (previousInputs && next.length === previousInputs.length && next.every((value, i) => value === previousInputs![i])) return previous;
    previousInputs = next;
    previous = compute(state);
    return previous;
  };
}
