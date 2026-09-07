'use client';

import type { EnvironmentImport as ImportResult } from '@/types/desktop';
import { useState } from 'react';
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
  return <div className="rounded-lg border border-neutral-700 bg-neutral-900 p-3 space-y-2">
    <button type="button" disabled={busy} onClick={() => void run()} className="rounded border border-neutral-600 px-3 py-1.5 text-sm text-neutral-100 hover:bg-neutral-800 disabled:opacity-50">
      {busy ? 'Importing…' : 'Import from .env'}
    </button>
    <p className="text-xs text-neutral-400">Import provider keys and ComfyUI settings from an existing .env or .env.local file. Keys are encrypted immediately. Existing values and the source file are kept.</p>
    {notice && <p role={error ? 'alert' : 'status'} className={`text-xs ${error ? 'text-red-300' : 'text-neutral-300'}`}>{notice}</p>}
  </div>;
}
