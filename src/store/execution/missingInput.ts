/**
 * Thrown by an executor when a node has nothing to work with: no prompt, no
 * image, no input at all. The run treats it as "skip this node and whatever
 * depends on it", not as a failure, so the rest of the graph still runs.
 */
export class MissingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingInputError";
  }
}

export function isMissingInputError(error: unknown): error is MissingInputError {
  return error instanceof MissingInputError || (error instanceof Error && error.name === "MissingInputError");
}
