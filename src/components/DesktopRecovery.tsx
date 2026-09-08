'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useWorkflowStore } from '@/store/workflowStore';
import { captureWorkflowTabSnapshot } from '@/store/utils/workflowTabs';
import { captureRecovery, checkpointScheduler, hydrateRecovery, encodeRecovery } from '@/lib/desktop/recovery';
import { isDesktop } from '@/lib/desktop/credentials';
import { DesktopStartupDragRegion } from './DesktopWindowControls';

let recoveryRead: ReturnType<NonNullable<Window['nodeBananaDesktop']>['recovery']['read']> | undefined;
export function DesktopRecovery({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [checkpoint, setCheckpoint] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isDesktop()) { setReady(true); return; }
    recoveryRead ??= window.nodeBananaDesktop!.recovery.read();
    void recoveryRead.then(result => {
      if (!result.ok) { setError(result.error); return; }
      setNotice(result.value.warnings.join(' ') || null);
      if (result.value.snapshot) setCheckpoint(result.value.snapshot);
      else setReady(true);
    }).catch(() => setError('Recovery could not be opened. Restart Node Banana to retry.'));
  }, []);
  useEffect(() => {
    if (!ready || !isDesktop()) return;
    const writer = checkpointScheduler(() => captureRecovery(useWorkflowStore.getState()), async snapshot => {
      const encoded = await encodeRecovery(snapshot);
      const result = await window.nodeBananaDesktop!.recovery.write(encoded);
      if (!result.ok) throw new Error(result.error);
    }, error => setNotice(error instanceof Error ? error.message : 'Recovery checkpoint failed. Save your workflows to disk.'));
    const unsubscribe = useWorkflowStore.subscribe((state, previous) => {
      const snapshot = captureWorkflowTabSnapshot(state);
      if (state.tabs !== previous.tabs || state.activeTabId !== previous.activeTabId || Object.keys(snapshot).some(key => state[key as keyof typeof state] !== previous[key as keyof typeof previous])) writer.changed();
    });
    writer.changed();
    return () => { unsubscribe(); writer.stop(); };
  }, [ready]);
  async function restore() {
    try {
      const result = await window.nodeBananaDesktop!.recovery.hydrate(checkpoint);
      if (!result.ok) throw new Error(result.error);
      const snapshot = await hydrateRecovery(result.value.snapshot);
      useWorkflowStore.getState().restoreDesktopSession(snapshot.tabs, snapshot.activeTabId);
      setNotice(['Session restored. Interrupted generations were stopped. Remote jobs may still be running; no requests were resubmitted.', ...result.value.warnings].join(' '));
      setCheckpoint(null); setError(null); setReady(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Recovery failed.'); }
  }
  async function discard() {
    const result = await window.nodeBananaDesktop!.recovery.discard();
    if (!result.ok) { setError(result.error); return; }
    setCheckpoint(null); setError(null); setReady(true);
  }
  return <>
    {!ready && <DesktopStartupDragRegion />}
    {ready ? children : <div className="h-screen bg-[#0f0f0f] text-neutral-300 flex items-center justify-center">Checking your previous session…</div>}
    {!ready && (!!checkpoint || error) && <div role="dialog" aria-modal="true" aria-label="Session recovery" className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-6">
      <div className="max-w-lg rounded-xl border border-neutral-700 bg-neutral-900 p-6 text-neutral-100 space-y-4">
        <p className="font-semibold">Restore your previous session?</p>
        <p className="text-sm">Node Banana did not close normally. Restore checkpointed tabs and edits, or discard them and open an empty workspace.</p>
        <p className="text-sm text-neutral-400">Interrupted generations will be stopped. Remote jobs may still be running. Recovery never submits requests.</p>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <div className="flex gap-3">
          {!!checkpoint && <button className="rounded border border-neutral-600 px-3 py-2" onClick={() => void restore()}>Restore Session</button>}
          <button className="rounded border border-neutral-600 px-3 py-2" onClick={() => void discard()}>Discard Recovery</button>
        </div>
      </div>
    </div>}
    {notice && ready && <div role="status" className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[9998] max-w-2xl rounded-lg border border-neutral-600 bg-neutral-900 p-4 text-sm text-neutral-200">
      {notice}<button aria-label="Dismiss recovery notice" className="ml-4 underline" onClick={() => setNotice(null)}>Dismiss</button>
    </div>}
  </>;
}
