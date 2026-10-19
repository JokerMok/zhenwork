import { brandState } from '@/features/workspace/brand';
import { useSettingsStore } from '@/store/modules/settings';

/**
 * 动态修改标题
 */
export const useDynamicTitle = () => {
  const settingsStore = useSettingsStore();
  if (settingsStore.dynamicTitle) {
    document.title = settingsStore.title + ' - ' + (brandState.data?.productName || '');
  } else {
    document.title = brandState.data?.productName || '';
  }
};
