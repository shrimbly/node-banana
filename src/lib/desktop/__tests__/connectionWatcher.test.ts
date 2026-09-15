import { afterEach, expect, it, vi } from 'vitest';
import { watchDesktopConnection } from '../connection';

let cleanup = () => {};
afterEach(() => cleanup());
function bridge(state = vi.fn(async () => true)) {
  let status: (online: boolean) => void = () => {};
  const unsubscribe = vi.fn();
  return { state, restart: vi.fn(async () => true), onStatus: (listener: typeof status) => { status = listener; return unsubscribe; }, emit: (online: boolean) => status(online), unsubscribe };
}

it('initializes from Electron and repairs a missed reconnect when the app regains focus', async () => {
  const backend = bridge();
  const change = vi.fn();
  cleanup = watchDesktopConnection(backend, change);
  await Promise.resolve();
  expect(change).toHaveBeenLastCalledWith(true);
  backend.emit(false);
  expect(change).toHaveBeenLastCalledWith(false);
  window.dispatchEvent(new Event('focus'));
  await Promise.resolve();
  expect(change).toHaveBeenLastCalledWith(true);
  expect(backend.state).toHaveBeenCalledTimes(2);
});

it('does not let a stale state query overwrite a newer disconnect event', async () => {
  let resolve!: (online: boolean) => void;
  const backend = bridge(vi.fn(() => new Promise<boolean>(done => { resolve = done; })));
  const change = vi.fn();
  cleanup = watchDesktopConnection(backend, change);
  backend.emit(false);
  resolve(true);
  await Promise.resolve();
  expect(change).toHaveBeenCalledExactlyOnceWith(false);
});

it('ignores pending results and focus events after cleanup', async () => {
  let resolve!: (online: boolean) => void;
  const backend = bridge(vi.fn(() => new Promise<boolean>(done => { resolve = done; })));
  const change = vi.fn();
  cleanup = watchDesktopConnection(backend, change);
  cleanup();
  resolve(true);
  window.dispatchEvent(new Event('focus'));
  await Promise.resolve();
  expect(change).not.toHaveBeenCalled();
  expect(backend.state).toHaveBeenCalledTimes(1);
  expect(backend.unsubscribe).toHaveBeenCalled();
  cleanup = () => {};
});

it('marks the connection offline if its state cannot be read', async () => {
  const backend = bridge(vi.fn(async () => { throw new Error('IPC unavailable'); }));
  const change = vi.fn();
  cleanup = watchDesktopConnection(backend, change);
  await Promise.resolve();
  await Promise.resolve();
  expect(change).toHaveBeenCalledWith(false);
});
