import { describe, it, expect, vi, afterEach } from "vitest";
import { confirmStopAgent, setAgentTurnStop } from "../stopGuard";

describe("confirmStopAgent", () => {
  afterEach(() => {
    setAgentTurnStop(null);
    vi.restoreAllMocks();
  });

  it("lets the user go without asking while no turn runs", () => {
    const confirm = vi.spyOn(window, "confirm");
    expect(confirmStopAgent("Switching workflows")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks while a turn runs, and stops it once the user agrees", () => {
    const stop = vi.fn();
    setAgentTurnStop(stop);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(confirmStopAgent("Switching workflows")).toBe(true);
    expect(confirm).toHaveBeenCalledWith("The agent is still working. Switching workflows will stop it.");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("keeps the turn going when the user declines", () => {
    const stop = vi.fn();
    setAgentTurnStop(stop);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(confirmStopAgent("Closing this tab")).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops asking once the turn has ended", () => {
    setAgentTurnStop(vi.fn());
    setAgentTurnStop(null);
    const confirm = vi.spyOn(window, "confirm");
    expect(confirmStopAgent("Opening a new tab")).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
