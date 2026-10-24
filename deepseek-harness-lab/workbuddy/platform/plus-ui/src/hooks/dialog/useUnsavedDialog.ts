import { ElMessageBox } from 'element-plus';
import { ref, watch, type Ref } from 'vue';
/** Only explicit user close goes through this guard; successful saves close normally. */
export function useUnsavedDialog(visible: Ref<boolean>, state: () => unknown, busy: Ref<boolean>) {
  const initial = ref('');
  watch(visible, open => {
    if (open) initial.value = JSON.stringify(state());
  });
  return async (done?: () => void) => {
    if (busy.value) return;
    if (initial.value !== JSON.stringify(state()))
      try {
        await ElMessageBox.confirm('尚未保存的修改将丢失。', '关闭编辑', {
          confirmButtonText: '放弃修改',
          cancelButtonText: '继续编辑',
          type: 'warning'
        });
      } catch {
        return;
      }
    visible.value = false;
    done?.();
  };
}
