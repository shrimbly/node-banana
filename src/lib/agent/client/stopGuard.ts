/**
 * Opening another workflow stops the agent's running turn: its edits only fit
 * the canvas it was sent from (see useAgentChat). The user's own ways of
 * leaving that canvas (a tab, the menu, Assets, a dropped file) ask first,
 * here; the agent's own tab steps never do.
 */

let stopRunningTurn: (() => void) | null = null;

/** The agent session registers how to stop its running turn, and null once the turn ends. */
export function setAgentTurnStop(stop: (() => void) | null): void {
  stopRunningTurn = stop;
}

/**
 * Asked before the user leaves the live workflow. True when no turn runs, or
 * when they agreed to stop it (it is stopped before this returns); false when
 * they kept the agent working. `action` names what they are doing:
 * "Switching workflows", "Closing this tab".
 */
export function confirmStopAgent(action: string): boolean {
  const stop = stopRunningTurn;
  if (!stop) return true;
  if (!window.confirm(`The agent is still working. ${action} will stop it.`)) return false;
  stop();
  return true;
}
