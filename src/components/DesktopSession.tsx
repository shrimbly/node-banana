'use client';

import { TriangleAlert, X } from "lucide-react";
import { watchDesktopConnection } from "@/lib/desktop/connection";
import { DesktopRecovery } from './DesktopRecovery';
import { DesktopWindowControls, DesktopStartupDragRegion } from './DesktopWindowControls';
import { useEffect, useState, type ReactNode } from 'react';
import { initializeDesktopCredentials, isDesktop, useSessionCredentials } from '@/lib/desktop/credentials';
import { getComfySettings, migrateLegacyComfyCloudKey } from '@/lib/comfy/settings';
import { getProviderSettings } from '@/store/utils/localStorage';
import { useWorkflowStore } from '@/store/workflowStore';
import { Dialog, DialogBody, DialogButton, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/Dialog';
import { CHROME_SURFACE } from './chromeStyles';

const WarningIcon = () => (
  <TriangleAlert size={16} strokeWidth={1.75} className="shrink-0 text-amber-400" />
);

const BANNER_ACTION = 'h-7 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-neutral-200 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30';

/**
 * Shown while the local server is down. Dismissible, and re-armed by the next
 * disconnect, so a reader is not stuck with it once they have seen it.
 */
function DisconnectedBanner() {
  const connected = useWorkflowStore(state => state.desktopConnected);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { if (connected) setDismissed(false); }, [connected]);
  if (connected || dismissed) return null;
  return <div role="status" className={`${CHROME_SURFACE} fixed left-1/2 top-[54px] z-[9998] flex w-max max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-xl py-1.5 pl-3.5 pr-1.5`}>
    <WarningIcon />
    <span className="text-xs leading-4 text-neutral-200">
      Local server disconnected. <span className="text-neutral-400">New executions are disabled; your graph remains open.</span>
    </span>
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" className={BANNER_ACTION} onClick={() => void window.nodeBananaDesktop?.backend.restart()}>Restart server</button>
      <button type="button" className={BANNER_ACTION} onClick={() => void window.nodeBananaDesktop?.openLogs()}>Open logs</button>
      <button type="button" aria-label="Dismiss" className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white" onClick={() => setDismissed(true)}>
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  </div>;
}

export function DesktopSession({ children }: { children: ReactNode }) {
  const setDesktopConnected = useWorkflowStore(state => state.setDesktopConnected);
  useEffect(() => {
    if (!isDesktop()) return;
    return watchDesktopConnection(window.nodeBananaDesktop!.backend, setDesktopConnected);
  }, [setDesktopConnected]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const hydrate = () => {
    // The store was created before the encrypted credentials were readable;
    // the key mirror has to be refreshed here too, or the Comfy key never
    // reaches the Generate nodes on the desktop.
    migrateLegacyComfyCloudKey();
    useWorkflowStore.setState({ providerSettings: getProviderSettings(), comfyCloudApiKey: getComfySettings().cloudApiKey });
    setReady(true);
  };
  const fail = (error: Error & { code?: string }) => setError({ message: error.message, code: error.code });
  const initialize = () => initializeDesktopCredentials().then(() => { hydrate(); setError(null); }).catch(fail);
  // Data the OS key no longer decrypts stays unreadable however often it is
  // retried; the reset moves it aside and initialises against an empty store.
  // Offered only for that failure: a locked keychain or a full disk leaves a
  // perfectly good file that a reset would move out of reach.
  const resettable = error?.code === 'undecryptable';
  const reset = () => window.nodeBananaDesktop!.credentials.reset()
    .then(result => { if (!result.ok) throw new Error(result.error); return initialize(); })
    .catch(fail);
  useEffect(() => {
    if (!isDesktop()) { setReady(true); return; }
    void initialize();
    const failed = (event: Event) => setError({ message: (event as CustomEvent<string>).detail });
    window.addEventListener('desktop-credential-error', failed);
    return () => { window.removeEventListener('desktop-credential-error', failed); };
    // Initialization is a shared, repeatable promise across StrictMode mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>
    {(!ready || error) && <DesktopStartupDragRegion />}
    {ready ? <DesktopRecovery>{children}</DesktopRecovery> : <div className="h-screen bg-[#0f0f0f] flex items-center justify-center text-xs text-neutral-500">Opening Node Banana…</div>}
    {ready && <DisconnectedBanner />}
    {/* Last, after every drag region: Electron applies app-regions in DOM order, and
        the controls' no-drag must be subtracted after the strips' drag is added. */}
    <DesktopWindowControls />
    <Dialog open={!!error} size="sm" label="Credential storage" overlayClassName="z-[10000]">
      <DialogHeader>
        <DialogTitle>Keys could not be saved securely</DialogTitle>
        <DialogDescription>{error?.message}</DialogDescription>
      </DialogHeader>
      <DialogBody scroll={false} className="pb-4">
        <p className="text-xs leading-4 text-neutral-500">
          {resettable ? 'Retrying reads the stored keys again. Resetting moves the unreadable file aside and starts an empty store. ' : 'Your existing stored keys are preserved. '}
          Session-only keys stay in memory and are lost when the app closes.
        </p>
      </DialogBody>
      <DialogFooter>
        {resettable && <DialogButton variant="ghost" onClick={() => void reset()}>Reset stored keys</DialogButton>}
        {/* eslint-disable-next-line react-hooks/rules-of-hooks -- useSessionCredentials is a store action ("use the keys for this session"), not a hook */}
        <DialogButton variant="ghost" onClick={() => { useSessionCredentials(); hydrate(); setError(null); }}>Use for this session only</DialogButton>
        <DialogButton variant="primary" autoFocus onClick={() => void initialize()}>Retry secure storage</DialogButton>
      </DialogFooter>
    </Dialog>
  </>;
}
