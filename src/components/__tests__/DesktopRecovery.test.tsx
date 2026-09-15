import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopRecovery } from '../DesktopRecovery';
import { Toast, useToast } from '../Toast';

vi.mock('@/lib/desktop/credentials', () => ({ isDesktop: () => true }));
vi.mock('@/store/workflowStore', () => {
  const state = { restoreDesktopSession: vi.fn(), incrementModalCount: vi.fn(), decrementModalCount: vi.fn() };
  return { useWorkflowStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state, subscribe: () => () => {} },
  ) };
});
vi.mock('@/lib/desktop/recovery', () => ({
  hydrateRecovery: async (snapshot: unknown) => snapshot,
  checkpointScheduler: () => ({ changed: vi.fn(), stop: vi.fn() }),
  captureRecovery: vi.fn(), encodeRecovery: vi.fn(),
}));
afterEach(() => {
  cleanup();
  delete (window as { nodeBananaDesktop?: unknown }).nodeBananaDesktop;
  useToast.getState().hide();
});

it('keeps lengthy recovery warnings in expandable details while preserving copyable diagnostics', async () => {
  const warnings = Array.from({ length: 20 }, (_, i) => `External media is missing: image-${i} (${('/a/very/long/project/path').repeat(8)})`);
  Object.defineProperty(window, 'nodeBananaDesktop', { configurable: true, value: {
    recovery: {
      read: async () => ({ ok: true, value: { snapshot: { version: 1 }, warnings: [] } }),
      hydrate: async () => ({ ok: true, value: { snapshot: { tabs: [], activeTabId: 'test' }, warnings } }),
    },
  } });
  render(<><DesktopRecovery><div>Editor</div></DesktopRecovery><Toast /></>);
  fireEvent.click(await screen.findByRole('button', { name: 'Restore session' }));
  expect(await screen.findByText('Session restored with 20 recovery warnings.')).toBeInTheDocument();
  expect(screen.queryByText(/External media is missing/)).not.toBeInTheDocument();
  expect(useToast.getState().details).toContain(warnings[19]);
  expect(useToast.getState().details).toContain('no requests were resubmitted');
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
  expect(screen.getByText(/External media is missing/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByTitle('Dismiss'));
  expect(screen.queryByText('Session restored with 20 recovery warnings.')).not.toBeInTheDocument();
});
