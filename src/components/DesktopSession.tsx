'use client';

import { DesktopRecovery } from './DesktopRecovery';
import { useEffect, useState, type ReactNode } from 'react';
import { initializeDesktopCredentials, isDesktop, useSessionCredentials } from '@/lib/desktop/credentials';
import { getProviderSettings } from '@/store/utils/localStorage';
import { useWorkflowStore } from '@/store/workflowStore';

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
    void initialize();
    const failed = (event: Event) => setError((event as CustomEvent<string>).detail);
    window.addEventListener('desktop-credential-error', failed);
    return () => window.removeEventListener('desktop-credential-error', failed);
    // Initialization is a shared, repeatable promise across StrictMode mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>
    {ready ? <DesktopRecovery>{children}</DesktopRecovery> : <div className="h-screen bg-[#0f0f0f] text-neutral-300 flex items-center justify-center">Opening Node Banana…</div>}
    {error && <div className="fixed inset-0 z-[10000] bg-black/70 flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="Credential storage">
      <div className="max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 p-6 text-neutral-100 space-y-4">
        <p className="font-semibold">Keys could not be saved securely</p>
        <p className="text-sm">{error}</p>
        <p className="text-sm text-neutral-400">Your existing stored keys are preserved. Session-only keys stay in memory and are lost when the app closes.</p>
        <div className="flex gap-3">
          <button className="rounded border border-neutral-600 px-3 py-2" onClick={() => void initialize()}>Retry secure storage</button>
          <button className="rounded border border-neutral-600 px-3 py-2" onClick={() => { useSessionCredentials(); hydrate(); setError(null); }}>Use for this session only</button>
        </div>
      </div>
    </div>}
  </>;
}
