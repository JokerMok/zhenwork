import { describe, expect, it, vi } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
const confirm = vi.hoisted(() => vi.fn());
vi.mock('element-plus', () => ({ ElMessageBox: { confirm } }));
import { useUnsavedDialog } from './useUnsavedDialog';
async function editor() {
  confirm.mockReset();
  const visible = ref(false), busy = ref(false);
  const form = reactive({ name: 'Original', temperature: '0.5', inputPrice: '1' });
  const close = useUnsavedDialog(visible, () => form, busy);
  visible.value = true;
  await nextTick();
  return { visible, busy, form, close };
}
describe('unsaved editor close protection', () => {
  it('keeps the draft on the focused primary continue action', async () => {
    const { visible, form, close } = await editor();
    form.inputPrice = '2'; confirm.mockResolvedValue('confirm');
    await close();
    expect(confirm.mock.calls[0][2]).toMatchObject({ confirmButtonText: '继续编辑', cancelButtonText: '放弃修改', autofocus: true, distinguishCancelAndClose: true, closeOnClickModal: false });
    expect(visible.value).toBe(true); expect(form.inputPrice).toBe('2');
  });
  it('retains parameter changes on Escape or the warning close button', async () => {
    const { visible, form, close } = await editor();
    form.temperature = '0.7'; confirm.mockRejectedValue('close');
    const done = vi.fn(); await close(done);
    expect(visible.value).toBe(true); expect(done).not.toHaveBeenCalled(); expect(form.temperature).toBe('0.7');
  });
  it('closes only when discard is explicitly selected', async () => {
    const { visible, form, close } = await editor();
    form.name = 'Edited'; confirm.mockRejectedValue('cancel');
    const done = vi.fn(); await close(done);
    expect(visible.value).toBe(false); expect(done).toHaveBeenCalledOnce();
  });
  it('closes unchanged or saved forms without warning, and blocks while saving', async () => {
    let current = await editor(); await current.close();
    expect(current.visible.value).toBe(false); expect(confirm).not.toHaveBeenCalled();
    current = await editor(); current.form.inputPrice = '9'; current.close.markSaved(); await current.close();
    expect(current.visible.value).toBe(false); expect(confirm).not.toHaveBeenCalled();
    current = await editor(); current.busy.value = true; await current.close();
    expect(current.visible.value).toBe(true); expect(confirm).not.toHaveBeenCalled();
  });
});
