import { expect, it, vi } from 'vitest';
import { useToast } from '@/components/Toast';
import { useWorkflowStore } from '@/store/workflowStore';
import { executeNanoBanana } from '@/store/execution';
vi.mock('@/store/execution', async importOriginal => ({
  ...await importOriginal<typeof import('@/store/execution')>(),
  executeNanoBanana: vi.fn(async () => {}),
}));
vi.mock('@/utils/logger', () => ({ logger: {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  startSession: vi.fn(async () => {}), endSession: vi.fn(async () => {}), getCurrentSession: vi.fn(() => null),
} }));
it('disconnect aborts existing work and blocks all new execution entry points', async () => {
  const original = useWorkflowStore.getState();
  const controller = new AbortController();
  try {
    useWorkflowStore.setState({ _abortController: controller, desktopConnected: true });
    const nodeId = useWorkflowStore.getState().addNode('nanoBanana', { x: 0, y: 0 });
    useWorkflowStore.getState().updateNodeData(nodeId, { inputPrompt: 'connection regression' });
    const graph = useWorkflowStore.getState().nodes;
    useWorkflowStore.getState().setDesktopConnected(false);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('desktop-backend-disconnected');
    await useWorkflowStore.getState().executeWorkflow();
    await useWorkflowStore.getState().executeSelectedNodes([nodeId]);
    await useWorkflowStore.getState().regenerateNode(nodeId);
    expect(executeNanoBanana).not.toHaveBeenCalled();
    expect(useToast.getState().message).toContain("Local server disconnected");
    expect(useWorkflowStore.getState().nodes).toBe(graph);
    useWorkflowStore.getState().setDesktopConnected(true);
    expect(useWorkflowStore.getState().isRunning).toBe(false);
    await useWorkflowStore.getState().executeWorkflow();
    await useWorkflowStore.getState().executeSelectedNodes([nodeId]);
    await useWorkflowStore.getState().regenerateNode(nodeId);
    expect(executeNanoBanana).toHaveBeenCalledTimes(3);
  } finally { useWorkflowStore.setState(original); }
});
