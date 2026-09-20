'use client';

import type { EnvironmentImport as ImportResult } from '@/types/desktop';
import { useState } from 'react';
import { DialogButton, DialogRow } from '@/components/ui/Dialog';
import { importDesktopEnvironment, isDesktop } from '@/lib/desktop/credentials';
import { getProviderSettings } from '@/store/utils/localStorage';
import { useWorkflowStore } from '@/store/workflowStore';

/** The first row of the Providers page on desktop: pull keys in from an .env file. */
export function EnvironmentImport({ onImported }: { onImported?: (result: Exclude<ImportResult, { cancelled: true }>) => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState(false);
  if (!isDesktop()) return null;
  async function run() {
    setBusy(true); setNotice(null); setError(false);
    try {
      const result = await importDesktopEnvironment();
      if (result.cancelled) return;
      useWorkflowStore.setState({ providerSettings: getProviderSettings() });
      onImported?.(result);
      const count = result.imported.length;
      setNotice(count ? `Imported ${count} credential ${count === 1 ? 'field' : 'fields'} and saved securely.${result.skipped.length ? ` Kept ${result.skipped.length} existing values.` : ''}` : 'No new credentials found. Existing values were kept.');
    } catch (error) {
      setError(true); setNotice(error instanceof Error ? error.message : 'Import failed. Existing credentials were preserved.');
    } finally { setBusy(false); }
  }
  return <div>
    <DialogRow
      first
      title="Import existing keys"
      description="Bring provider keys and ComfyUI settings from an .env file. Existing keys are kept."
      className="pt-0 pb-3.5"
    >
      <DialogButton variant="outline" size="md" disabled={busy} onClick={() => void run()} className="h-8 shrink-0">
        {busy ? 'Importing…' : 'Import from .env'}
      </DialogButton>
    </DialogRow>
    {notice && <p role={error ? 'alert' : 'status'} className={`-mt-1 pb-3.5 text-xs leading-4 ${error ? 'text-error' : 'text-neutral-400'}`}>{notice}</p>}
  </div>;
}
