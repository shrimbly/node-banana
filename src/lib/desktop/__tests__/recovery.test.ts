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
    await expect(encodeRecovery(value)).rejects.toThrow('Expired blob');
  } finally {
    global.fetch = originalFetch;
    delete (window as { nodeBananaDesktop?: unknown }).nodeBananaDesktop;
  }
});
