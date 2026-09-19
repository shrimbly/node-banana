'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useWorkflowStore } from '@/store/workflowStore';
import { captureWorkflowTabSnapshot } from '@/store/utils/workflowTabs';
import { captureRecovery, checkpointScheduler, hydrateRecovery, encodeRecovery } from '@/lib/desktop/recovery';
import { isDesktop } from '@/lib/desktop/credentials';
import { DesktopStartupDragRegion } from './DesktopWindowControls';
import { Dialog, DialogBody, DialogButton, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/Dialog';
import { useToast } from './Toast';

let recoveryRead: ReturnType<NonNullable<Window['nodeBananaDesktop']>['recovery']['read']> | undefined;
export function DesktopRecovery({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [checkpoint, setCheckpoint] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  // Warnings and the post-restore summary use the app's own notification
  // stack; they stay until dismissed, like any other persistent toast.
  const setNotice = (message: string, details?: string) => useToast.getState().show(message, 'info', true, details);
  useEffect(() => {
    if (!isDesktop()) { setReady(true); return; }
    recoveryRead ??= window.nodeBananaDesktop!.recovery.read();
    void recoveryRead.then(result => {
      if (!result.ok) { setError(result.error); return; }
      if (result.value.warnings.length) {
        setNotice('Session recovery needs attention.', result.value.warnings.join('\n\n'));
      }
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
    }, error => setNotice('Recovery checkpoint failed. Save your workflows to disk.', error instanceof Error ? error.message : undefined));
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
      const warnings = result.value.warnings;
      setNotice(
        warnings.length ? `Session restored with ${warnings.length} recovery warning${warnings.length === 1 ? '' : 's'}.` : 'Session restored.',
        ['Interrupted generations were stopped. Remote jobs may still be running; no requests were resubmitted.', ...warnings].join('\n\n'),
      );
      setCheckpoint(null); setError(null); setReady(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Recovery failed.'); }
  }
  async function discard() {
    const result = await window.nodeBananaDesktop!.recovery.discard();
    if (!result.ok) { setError(result.error); return; }
    setCheckpoint(null); setError(null); setReady(true);
  }
  const showDialog = !ready && (!!checkpoint || !!error);
  return <>
    {!ready && <DesktopStartupDragRegion />}
    {ready ? children : <div className="h-screen bg-[#0f0f0f] flex items-center justify-center text-xs text-neutral-500">Checking your previous session…</div>}
    <Dialog open={showDialog} size="sm" label="Session recovery">
      <DialogHeader>
        <DialogTitle>{checkpoint ? 'Restore your previous session?' : 'Session recovery'}</DialogTitle>
        <DialogDescription>
          {checkpoint
            ? 'Node Banana did not close normally. Restore checkpointed tabs and edits, or discard them and open an empty workspace.'
            : 'Node Banana did not close normally and the checkpoint could not be read.'}
        </DialogDescription>
      </DialogHeader>
      <DialogBody scroll={false} className="flex flex-col gap-2 pb-4">
        <p className="text-xs leading-4 text-neutral-500">Interrupted generations will be stopped. Remote jobs may still be running. Recovery never submits requests.</p>
        {error && <p role="alert" className="rounded-md bg-red-500/10 px-2.5 py-2 text-xs leading-4 text-red-300">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="ghost" onClick={() => void discard()}>{checkpoint ? 'Discard' : 'Open empty workspace'}</DialogButton>
        {!!checkpoint && <DialogButton variant="primary" autoFocus onClick={() => void restore()}>Restore session</DialogButton>}
      </DialogFooter>
    </Dialog>
  </>;
}
