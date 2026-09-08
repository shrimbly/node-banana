'use client';

import { DesktopRecovery } from './DesktopRecovery';
import { DesktopWindowControls, DesktopStartupDragRegion } from './DesktopWindowControls';
import { useEffect, useState, type ReactNode } from 'react';
import { initializeDesktopCredentials, isDesktop, useSessionCredentials } from '@/lib/desktop/credentials';
import { getProviderSettings } from '@/store/utils/localStorage';
import { useWorkflowStore } from '@/store/workflowStore';
import { Dialog, DialogBody, DialogButton, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/Dialog';
import { CHROME_SURFACE } from './chromeStyles';

const WarningIcon = () => (
  <svg className="h-4 w-4 shrink-0 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 9v4m0 4h.01" />
    <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />
  </svg>
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
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true"><path d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </div>
  </div>;
}

export function DesktopSession({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydrate = () => {
    useWorkflowStore.setState({ providerSettings: getProviderSettings() });
    setReady(true);
  };
  const initialize = () => initializeDesktopCredentials().then(() => { hydrate(); setError(null); }).catch(error => setError(error.message));
  useEffect(() => {
    if (!isDesktop()) { setReady(true); return; }
    const update = (online: boolean) => useWorkflowStore.getState().setDesktopConnected(online);
    const unsubscribe = window.nodeBananaDesktop!.backend.onStatus(update);
    void window.nodeBananaDesktop!.backend.state().then(update);
    void initialize();
    const failed = (event: Event) => setError((event as CustomEvent<string>).detail);
    window.addEventListener('desktop-credential-error', failed);
    return () => { unsubscribe(); window.removeEventListener('desktop-credential-error', failed); };
    // Initialization is a shared, repeatable promise across StrictMode mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>
    <DesktopWindowControls />
    {(!ready || error) && <DesktopStartupDragRegion />}
    {ready ? <DesktopRecovery>{children}</DesktopRecovery> : <div className="h-screen bg-[#0f0f0f] flex items-center justify-center text-xs text-neutral-500">Opening Node Banana…</div>}
    {ready && <DisconnectedBanner />}
    <Dialog open={!!error} size="sm" label="Credential storage" overlayClassName="z-[10000]">
      <DialogHeader>
        <DialogTitle>Keys could not be saved securely</DialogTitle>
        <DialogDescription>{error}</DialogDescription>
      </DialogHeader>
      <DialogBody scroll={false} className="pb-4">
        <p className="text-xs leading-4 text-neutral-500">Your existing stored keys are preserved. Session-only keys stay in memory and are lost when the app closes.</p>
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="ghost" onClick={() => { useSessionCredentials(); hydrate(); setError(null); }}>Use for this session only</DialogButton>
        <DialogButton variant="primary" autoFocus onClick={() => void initialize()}>Retry secure storage</DialogButton>
      </DialogFooter>
    </Dialog>
  </>;
}
