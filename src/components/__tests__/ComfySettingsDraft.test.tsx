import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useComfySettingsDraft } from '../settings/ComfySettingsTab';
import { COMFY_SETTINGS_KEY, defaultComfySettings, saveComfySettings, getComfySettings } from '@/lib/comfy/settings';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('replaces default endpoints after import and saves the imported connection', () => {
  const { result } = renderHook(() => useComfySettingsDraft(true));
  expect(result.current[0].localUrl).toBe('http://127.0.0.1:8188');
  const imported = { ...defaultComfySettings, mode: 'local' as const, localUrl: 'http://127.0.0.1:9000', cloudUrl: 'https://cloud.example.test' };
  act(() => result.current[2](imported, ['localUrl', 'cloudUrl', 'mode']));
  expect(result.current[0]).toMatchObject(imported);
  saveComfySettings(result.current[0]);
  expect(getComfySettings().localUrl).toBe(imported.localUrl);
  expect(JSON.parse(localStorage.getItem(COMFY_SETTINGS_KEY)!)).toMatchObject({ localUrl: imported.localUrl, mode: 'local' });
});

it('preserves explicit draft edits, including clears, and resets them on reopening', () => {
  const { result, rerender } = renderHook(({ open }) => useComfySettingsDraft(open), { initialProps: { open: true } });
  act(() => result.current[1]({ ...result.current[0], localUrl: 'http://my-server:7777', remoteUrl: 'http://temporary:8188' }));
  act(() => result.current[1]({ ...result.current[0], remoteUrl: '' }));
  const imported = { ...defaultComfySettings, localUrl: 'http://imported:9000', remoteUrl: 'http://imported-remote:8188' };
  act(() => result.current[2](imported, ['localUrl', 'remoteUrl']));
  expect(result.current[0].localUrl).toBe('http://my-server:7777');
  expect(result.current[0].remoteUrl).toBe('');
  rerender({ open: false }); rerender({ open: true });
  act(() => result.current[2](imported, ['localUrl', 'remoteUrl']));
  expect(result.current[0].localUrl).toBe(imported.localUrl);
  expect(result.current[0].remoteUrl).toBe(imported.remoteUrl);
});
