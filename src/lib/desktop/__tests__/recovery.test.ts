import { afterEach, expect, it, vi } from 'vitest';
import { checkpointScheduler, decodeRecovery, type RecoverySnapshot } from '../recovery';
import { emptyWorkflowTabSnapshot } from '@/store/utils/workflowTabs';
import { defaultEdgeAppearance } from '@/types';
afterEach(() => vi.useRealTimers());
const snapshot = (): RecoverySnapshot => ({ version: 1, savedAt: 1, activeTabId: 'a', tabs: [{ id: 'a', snapshot: emptyWorkflowTabSnapshot({ edgeStyle: 'curved', edgeAppearance: defaultEdgeAppearance, useExternalImageStorage: true }) }] });
it('restores sets, paths, costs and stopped nodes without resumable state', () => {
  const value = snapshot();
  Object.assign(value.tabs[0].snapshot, { canvasViewport: { x: 120, y: -90, zoom: 0.85 }, incurredCost: 12.3, saveDirectoryPath: '/tmp/workflow', viewedCommentNodeIds: ['comment'], pausedAtNodeId: 'a', nodes: [{ id: 'a', type: 'nanoBanana', data: { status: 'loading' } }] });
  const result = decodeRecovery(value).tabs[0].snapshot;
  expect(result.viewedCommentNodeIds).toEqual(new Set(['comment']));
  expect(result.incurredCost).toBe(12.3);
  expect(result.canvasViewport).toEqual({ x: 120, y: -90, zoom: 0.85 });
  expect(result.saveDirectoryPath).toBe('/tmp/workflow');
  expect(result.pausedAtNodeId).toBeNull();
  expect(result.nodes[0].data).toMatchObject({ status: 'error', error: expect.stringContaining('no requests were resubmitted') });
});
it('debounces for one second and checkpoints continuous edits at five seconds', async () => {
  vi.useFakeTimers();
  const save = vi.fn(async () => {});
  const writer = checkpointScheduler(snapshot, save, vi.fn());
  for (let i = 0; i < 10; i++) { writer.changed(); await vi.advanceTimersByTimeAsync(500); }
  expect(save).toHaveBeenCalledTimes(1);
  writer.changed();
  await vi.advanceTimersByTimeAsync(999);
  expect(save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledTimes(2);
  writer.stop();
});
it('serializes slow writes and coalesces later changes', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const writer = checkpointScheduler(snapshot, save, vi.fn());
  writer.changed(); await vi.advanceTimersByTimeAsync(1000);
  writer.changed(); await vi.advanceTimersByTimeAsync(6000);
  expect(save).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(save).toHaveBeenCalledTimes(2);
  writer.stop(); finish();
});
it('persists blob bytes before encoding and rejects expired URLs without publishing', async () => {
  const { encodeRecovery } = await import('../recovery');
  const putAsset = vi.fn(async () => ({ ok: true, value: { $recoveryAsset: 'hash', mime: 'video/mp4' } }));
  Object.defineProperty(window, 'nodeBananaDesktop', { configurable: true, value: { recovery: { putAsset } } });
  const originalFetch = global.fetch;
  try {
    global.fetch = vi.fn(async () => ({ ok: true, blob: async () => ({ type: 'video/mp4', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) })) as unknown as typeof fetch;
    const value = snapshot();
    Object.assign(value.tabs[0].snapshot, { nodes: [{ id: 'video', data: { outputVideo: 'blob:http://127.0.0.1/media', history: ['blob:http://127.0.0.1/media'] } }] });
    const encoded = JSON.stringify(await encodeRecovery(value));
    expect(encoded).not.toContain('blob:');
    expect(encoded).toContain('$recoveryAsset');
    expect(putAsset).toHaveBeenCalledTimes(1);
    global.fetch = vi.fn(async () => { throw new Error('Expired blob'); });
    // A cached, durable blob remains recoverable after its URL is revoked.
    await expect(encodeRecovery(value)).resolves.toBeDefined();
    Object.assign(value.tabs[0].snapshot.nodes[0].data, { outputVideo: 'blob:http://127.0.0.1/never-saved' });
    await expect(encodeRecovery(value)).rejects.toThrow('Expired blob');
  } finally {
    global.fetch = originalFetch;
    delete (window as { nodeBananaDesktop?: unknown }).nodeBananaDesktop;
  }
});

it('externalizes repeated data URLs before IPC and reuses the next checkpoint media', async () => {
  vi.resetModules();
  const { encodeRecovery } = await import('../recovery');
  const ref = { $recoveryAsset: 'hash', mime: 'image/png' };
  const putAsset = vi.fn(async () => ({ ok: true, value: ref }));
  Object.defineProperty(window, 'nodeBananaDesktop', { configurable: true, value: { recovery: { putAsset } } });
  const originalFetch = global.fetch;
  try {
    global.fetch = vi.fn(async () => ({ ok: true, blob: async () => ({ type: 'image/png', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) })) as unknown as typeof fetch;
    const value = snapshot();
    const image = `data:image/png;base64,${'A'.repeat(1024 * 1024)}`;
    Object.assign(value.tabs[0].snapshot, { nodes: Array.from({ length: 471 }, (_, i) => ({ id: String(i), data: { image, outputImage: image } })) });
    const encoded = await encodeRecovery(value);
    expect(JSON.stringify(encoded).length).toBeLessThan(100000);
    expect(JSON.stringify(encoded)).not.toContain('data:image');
    expect(putAsset).toHaveBeenCalledTimes(1);
    await encodeRecovery(value);
    expect(putAsset).toHaveBeenCalledTimes(1);
    await encodeRecovery(snapshot());
    await encodeRecovery(snapshot());
    // Undo may revive media after both disk checkpoints have released it.
    // The encoder must upload again instead of reusing an expired cache entry.
    await encodeRecovery(value);
    expect(putAsset).toHaveBeenCalledTimes(2);
  } finally { global.fetch = originalFetch; delete (window as { nodeBananaDesktop?: unknown }).nodeBananaDesktop; }
});

it('hydrates duplicate references in renderer memory with bounded reads', async () => {
  const { hydrateRecovery } = await import('../recovery');
  const readAsset = vi.fn(async ({ offset }: { offset: number }) => ({ ok: true, value: { bytes: new Uint8Array(offset ? [3] : [1, 2]), size: 3 } }));
  Object.defineProperty(window, 'nodeBananaDesktop', { configurable: true, value: { recovery: { readAsset } } });
  try {
    const value = snapshot();
    const asset = { $recoveryAsset: 'hash', mime: 'image/png' };
    Object.assign(value.tabs[0].snapshot, { nodes: [{ id: 'a', data: { image: asset, outputImage: asset } }] });
    const result = await hydrateRecovery(value);
    expect(result.tabs[0].snapshot.nodes[0].data).toMatchObject({ image: 'data:image/png;base64,AQID', outputImage: 'data:image/png;base64,AQID' });
    expect(readAsset.mock.calls.map(([request]) => request.offset)).toEqual([0, 2]);
  } finally { delete (window as { nodeBananaDesktop?: unknown }).nodeBananaDesktop; }
});
