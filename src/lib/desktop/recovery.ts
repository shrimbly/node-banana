import type { WorkflowStore } from '@/store/workflowStore';
import { captureWorkflowTabSnapshot, emptyWorkflowTabSnapshot, type WorkflowTabSnapshot } from '@/store/utils/workflowTabs';
import { defaultEdgeAppearance } from '@/types';

export interface RecoverySnapshot {
  version: 1;
  savedAt: number;
  activeTabId: string;
  tabs: { id: string; snapshot: WorkflowTabSnapshot }[];
}
const setFields = ['viewedCommentNodeIds', 'dimmedNodeIds', 'skippedNodeIds'] as const;
const interruption = 'Stopped after recovery. Remote jobs may still be running; no requests were resubmitted.';

export function captureRecovery(state: WorkflowStore): RecoverySnapshot {
  return { version: 1, savedAt: Date.now(), activeTabId: state.activeTabId, tabs: state.tabs.map(tab => ({
    id: tab.id,
    snapshot: { ...captureWorkflowTabSnapshot(tab.id === state.activeTabId ? state : tab.snapshot!), pausedAtNodeId: null },
  })) };
}

export function decodeRecovery(raw: unknown): RecoverySnapshot {
  const value = raw as RecoverySnapshot;
  if (value?.version !== 1 || !Array.isArray(value.tabs) || !value.tabs.length || !value.tabs.some(tab => tab.id === value.activeTabId)) throw new Error('Unsupported recovery checkpoint');
  const ids = new Set<string>();
  return { ...value, tabs: value.tabs.map(tab => {
    if (!tab || typeof tab.id !== 'string' || ids.has(tab.id) || !Array.isArray(tab.snapshot?.nodes) || !Array.isArray(tab.snapshot?.edges)) throw new Error('Invalid recovery tab');
    ids.add(tab.id);
    const snapshot = { ...emptyWorkflowTabSnapshot({ edgeStyle: 'curved', edgeAppearance: defaultEdgeAppearance, useExternalImageStorage: true }), ...tab.snapshot };
    for (const key of setFields) snapshot[key] = new Set(Array.isArray(snapshot[key]) ? snapshot[key] as unknown as string[] : []);
    snapshot.pausedAtNodeId = null;
    snapshot.nodes = snapshot.nodes.map(node => {
      const data = { ...node.data } as Record<string, unknown>;
      if (['running', 'loading', 'pending', 'processing', 'queued'].includes(String(data.status))) {
        data.status = 'error';
        data.error = interruption;
        data.progress = 0;
      }
      delete data.abortController;
      delete data.execution;
      return { ...node, dragging: false, data: data as typeof node.data };
    });
    return { id: tab.id, snapshot };
  }) };
}

type RecoveryAsset = { $recoveryAsset: string; mime: string };
// Reuse the previous checkpoint's immutable media without retaining closed tabs.
let previousAssets = new Map<string, Promise<RecoveryAsset>>();
export async function encodeRecovery(snapshot: RecoverySnapshot): Promise<unknown> {
  const assets = new Map<string, Promise<RecoveryAsset>>();
  async function walk(value: unknown): Promise<unknown> {
    if (typeof value === 'string' && (value.startsWith('blob:') || /^data:[\w.+-]+\/[\w.+-]+[;,]/.test(value))) {
      let asset = assets.get(value) || previousAssets.get(value);
      if (!asset) {
        asset = (async () => {
          const response = await fetch(value);
          if (!response.ok) throw new Error('Recovery could not read media. Save your workflow before closing.');
          const blob = await response.blob();
          const result = await window.nodeBananaDesktop!.recovery.putAsset({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'application/octet-stream' });
          if (!result.ok) throw new Error(result.error);
          return result.value;
        })();
      }
      assets.set(value, asset);
      return asset;
    }
    if (value instanceof Set) return [...value];
    if (Array.isArray(value)) { const result = []; for (const item of value) result.push(await walk(item)); return result; }
    if (value && typeof value === 'object') {
      if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (['abortController', '_abortController', 'execution', 'undoHistory'].includes(key) || typeof child === 'function') continue;
        result[key] = await walk(child);
      }
      return result;
    }
    return value;
  }
  const encoded = await walk(snapshot);
  // Reject before IPC, whose structured clone allocation can crash the main
  // process before its handler gets a chance to validate a large payload.
  if (JSON.stringify(encoded).length > 8 * 1024 * 1024) throw new Error('Recovery metadata is too large. Save your workflows to disk.');
  previousAssets = assets;
  return encoded;
}

export async function hydrateRecovery(raw: unknown): Promise<RecoverySnapshot> {
  const assets = new Map<string, Promise<string>>();
  async function walk(value: unknown): Promise<unknown> {
    if (!value || typeof value !== 'object') return value;
    const asset = value as RecoveryAsset;
    if (typeof asset.$recoveryAsset === 'string') {
      let loaded = assets.get(asset.$recoveryAsset);
      if (!loaded) {
        loaded = (async () => {
          const parts: ArrayBuffer[] = [];
          let offset = 0;
          while (true) {
            const result = await window.nodeBananaDesktop!.recovery.readAsset({ asset, offset });
            if (!result.ok) throw new Error(result.error);
            const { bytes, size } = result.value;
            if (size > 256 * 1024 * 1024 || offset + bytes.length > size || (!bytes.length && offset < size)) throw new Error('Invalid recovery media');
            parts.push(new Uint8Array(bytes).buffer);
            offset += bytes.length;
            if (offset === size) break;
          }
          const url = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(new Error('Recovery media could not be opened.'));
            reader.readAsDataURL(new Blob(parts, { type: asset.mime }));
          });
          previousAssets.set(url, Promise.resolve(asset));
          return url;
        })();
        assets.set(asset.$recoveryAsset, loaded);
      }
      return loaded;
    }
    if (Array.isArray(value)) { const result = []; for (const child of value) result.push(await walk(child)); return result; }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) result[key] = await walk(child);
    return result;
  }
  return decodeRecovery(await walk(raw));
}

// One writer; pending edits coalesce to the latest graph. The maximum timer is
// never reset by another edit, so continuous dragging/typing still checkpoints.
export function checkpointScheduler(capture: () => RecoverySnapshot, save: (snapshot: RecoverySnapshot) => Promise<void>, onError: (error: unknown) => void) {
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let maximum: ReturnType<typeof setTimeout> | undefined;
  let running = false, dirty = false, stopped = false;
  const clear = () => { clearTimeout(debounce); clearTimeout(maximum); debounce = maximum = undefined; };
  const flush = async () => {
    clear();
    if (running || stopped || !dirty) return;
    running = true;
    dirty = false;
    try { await save(capture()); } catch (error) { onError(error); }
    finally { running = false; if (dirty && !stopped) void flush(); }
  };
  return {
    changed() {
      if (stopped) return;
      dirty = true;
      clearTimeout(debounce);
      debounce = setTimeout(() => void flush(), 1000);
      maximum ??= setTimeout(() => void flush(), 5000);
    },
    flush,
    stop() { stopped = true; clear(); },
  };
}
