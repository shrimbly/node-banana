import { useSyncExternalStore } from "react";
import { getRecorderLibraryStatus, onLibraryStatus } from "@/lib/assets/client/recorder";

const subscribe = (listener: () => void) => onLibraryStatus(() => listener());
const serverSnapshot = () => null;

/**
 * Whether Add media can be offered: false once the library's status
 * says it is off (a hosted server, a refused page, an unwritable folder).
 * Before the first answer it is offered, and the picker shows what the list
 * request says.
 */
export function useLibraryAvailable(): boolean {
  const status = useSyncExternalStore(subscribe, getRecorderLibraryStatus, serverSnapshot);
  return status === null || status.available;
}
