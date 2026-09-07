import { expect, it } from 'vitest';
import { useWorkflowStore } from '@/store/workflowStore';
it('disconnect aborts existing work and blocks all new execution entry points', async () => {
  const original = useWorkflowStore.getState();
  const controller = new AbortController();
  try {
    useWorkflowStore.setState({ _abortController: controller, desktopConnected: true });
    const graph = useWorkflowStore.getState().nodes;
    useWorkflowStore.getState().setDesktopConnected(false);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('desktop-backend-disconnected');
    await useWorkflowStore.getState().executeWorkflow();
    await useWorkflowStore.getState().executeSelectedNodes(['any']);
    await useWorkflowStore.getState().regenerateNode('any');
    expect(useWorkflowStore.getState().nodes).toBe(graph);
    useWorkflowStore.getState().setDesktopConnected(true);
    expect(useWorkflowStore.getState().isRunning).toBe(false);
  } finally { useWorkflowStore.setState(original); }
});
