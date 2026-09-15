import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopSession } from '../DesktopSession';

vi.mock('@/lib/desktop/credentials', () => ({
  isDesktop: () => true,
  initializeDesktopCredentials: () => Promise.reject(new Error('Disk full')),
  useSessionCredentials: vi.fn(),
}));
vi.mock('@/store/utils/localStorage', () => ({ getProviderSettings: () => ({ providers: {} }) }));
const connectionState = vi.hoisted(() => ({ desktopConnected: true, setDesktopConnected: vi.fn<(online: boolean) => void>() }));
vi.mock('@/store/workflowStore', () => ({ useWorkflowStore: Object.assign(
  (selector: (state: typeof connectionState) => unknown) => selector(connectionState),
  { setState: vi.fn(), getState: () => connectionState },
) }));
afterEach(() => {
  delete (window as { nodeBananaDesktop?: unknown }).nodeBananaDesktop;
  delete (window as { nodeBananaWindow?: unknown }).nodeBananaWindow;
});

it('keeps window actions and dragging available through credential failure and recovery decisions', async () => {
  const close = vi.fn();
  Object.defineProperty(window, 'nodeBananaWindow', { configurable: true, value: { close, minimize: vi.fn(), toggleFullscreen: vi.fn() } });
  Object.defineProperty(window, 'nodeBananaDesktop', { configurable: true, value: {
    backend: { onStatus: () => vi.fn(), state: async () => true },
    recovery: { read: async () => ({ ok: true, value: { snapshot: { version: 1 }, warnings: [] } }) },
  } });
  const { container } = render(<DesktopSession><div>Editor workspace</div></DesktopSession>);
  expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
  expect(container.querySelector('.desktop-startup-drag-region')).toBeInTheDocument();
  await screen.findByRole('dialog', { name: 'Credential storage' });
  expect(screen.queryByText('Editor workspace')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
  expect(close).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Use for this session only' }));
  await screen.findByRole('dialog', { name: 'Session recovery' });
  expect(screen.queryByText('Editor workspace')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Minimise window' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Toggle fullscreen' })).toBeInTheDocument();
  expect(container.querySelector('.desktop-startup-drag-region')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close window' }));
  expect(close).toHaveBeenCalledTimes(2);
});


it('resynchronizes when the store connection action changes during a dev refresh', async () => {
  const unsubscribe = vi.fn();
  const state = vi.fn(async () => true);
  Object.defineProperty(window, 'nodeBananaDesktop', { configurable: true, value: {
    backend: { onStatus: () => unsubscribe, state },
  } });
  const first = connectionState.setDesktopConnected;
  first.mockClear();
  const { rerender, unmount } = render(<DesktopSession><div>Editor</div></DesktopSession>);
  await waitFor(() => expect(first).toHaveBeenCalledWith(true));
  const replacement = vi.fn<(online: boolean) => void>();
  connectionState.setDesktopConnected = replacement;
  rerender(<DesktopSession><div>Editor</div></DesktopSession>);
  await waitFor(() => expect(replacement).toHaveBeenCalledWith(true));
  expect(unsubscribe).toHaveBeenCalled();
  unmount();
  connectionState.setDesktopConnected = first;
});
