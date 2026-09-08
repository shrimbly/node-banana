'use client';

import type { EnvironmentImport as ImportResult } from '@/types/desktop';
import { useState } from 'react';
import { DialogButton } from '@/components/ui/Dialog';
import { importDesktopEnvironment, isDesktop } from '@/lib/desktop/credentials';
import { getProviderSettings } from '@/store/utils/localStorage';
import { useWorkflowStore } from '@/store/workflowStore';

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
  return <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-4">
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm font-medium text-neutral-100">Import existing keys</h3>
        <p className="max-w-[52ch] text-xs leading-5 text-neutral-400">
          Bring provider keys and ComfyUI settings from an .env file. Existing keys are kept.
        </p>
      </div>
      <DialogButton disabled={busy} onClick={() => void run()} className="h-10 shrink-0 whitespace-nowrap">
        {busy ? 'Importing…' : 'Import from .env'}
      </DialogButton>
    </div>
    {notice && <p role={error ? 'alert' : 'status'} className={`mt-3 border-t border-neutral-800 pt-3 text-xs leading-5 ${error ? 'text-red-300' : 'text-neutral-300'}`}>{notice}</p>}
  </div>;
}
