import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

type WebConversation = { key: string; id: string; source: 'enterprise_web'; name: string;
  modified_at: number | null; status: string | null; pinned: boolean };
type EnterpriseWindow = Window & {
  enterpriseContext?: { webOrigin?: string };
  enterpriseResources?: { request: (action: string, args?: unknown) => Promise<unknown> };
};

export const hasEnterpriseWebConversationSource = (): boolean => {
  if (typeof window === 'undefined') return false;
  const enterprise = window as EnterpriseWindow;
  return Boolean(enterprise.enterpriseResources && enterprise.enterpriseContext?.webOrigin?.startsWith('https://'));
};

/** A server Core is the source of truth; these IDs never enter the local Core router. */
export const EnterpriseWebConversations: React.FC<{ collapsed: boolean }> = ({ collapsed }) => {
  const { t } = useTranslation();
  const enterprise = window as EnterpriseWindow;
  const available = hasEnterpriseWebConversationSource();
  const [items, setItems] = useState<WebConversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const refreshSeq = useRef(0);
  const refresh = useCallback(async () => {
    if (!available) return;
    const seq = ++refreshSeq.current;
    try {
      const result = await enterprise.enterpriseResources!.request('web-conversations') as
        { items: WebConversation[]; next_cursor: string | null };
      if (!Array.isArray(result.items)) throw new Error('Invalid web conversations');
      if (seq === refreshSeq.current) {
        setItems(result.items); setNextCursor(result.next_cursor); setFailed(false);
      }
    } catch { if (seq === refreshSeq.current) setFailed(true); }
  }, [available, enterprise.enterpriseResources]);
  useEffect(() => {
    if (!available) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    window.addEventListener('focus', refresh);
    return () => { ++refreshSeq.current; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [available, refresh]);
  if (!available) return null;
  const mutate = async (action: string, item: WebConversation, args: Record<string, unknown> = {}) => {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await enterprise.enterpriseResources!.request(action, { id: item.id, ...args });
      setEditingId(null); setDeletingId(null);
      await refresh();
    } catch { setFailed(true); }
    finally { setBusyId(null); }
  };
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await enterprise.enterpriseResources!.request('web-conversations', { cursor: nextCursor }) as
        { items: WebConversation[]; next_cursor: string | null };
      if (!Array.isArray(result.items)) throw new Error('Invalid web conversations');
      setItems((current) => [...current, ...result.items.filter((item) => !current.some((old) => old.key === item.key))]);
      setNextCursor(result.next_cursor);
      setFailed(false);
    } catch { setFailed(true); }
    finally { setLoadingMore(false); }
  };
  return (
    <section className='min-w-0' aria-label={t('conversation.history.webConversations')}>
      {!collapsed && <div className='px-12px h-28px flex items-center text-14px text-t-tertiary font-[500]'>
        {t('conversation.history.webConversations')}
      </div>}
      {failed && !collapsed && <div className='px-12px text-12px text-t-tertiary'>
        {t('conversation.history.webConversationsUnavailable')}
      </div>}
      {items.map((item) => (
        <div key={item.key} className='min-w-0'>
          <div className='w-full h-34px px-10px rd-8px flex items-center gap-8px hover:bg-fill-3'>
            <button type='button' className='min-w-0 flex-1 h-full flex items-center gap-8px text-left text-t-primary border-0 bg-transparent cursor-pointer'
              title={`${item.name} · ${t('conversation.history.webConversationLocation')}`}
              onClick={() => { void enterprise.enterpriseResources?.request('web-open', { id: item.id })
                .catch(() => setFailed(true)); }}>
              <span className='text-14px shrink-0' aria-hidden='true'>☁</span>
              {!collapsed && <><span className='truncate flex-1 text-14px'>{item.name}</span>
                {item.pinned && <span title={t('conversation.history.pin')} aria-hidden='true'>📌</span>}
                <span className='text-11px text-t-tertiary shrink-0'>{t('conversation.history.webConversationSource')}</span></>}
            </button>
            {!collapsed && <details className='relative shrink-0'>
              <summary className='cursor-pointer text-t-secondary' aria-label={t('conversation.history.webConversationActions')}>⋯</summary>
              <div className='absolute right-0 z-20 min-w-120px p-6px rd-8px bg-bg-2 shadow-md flex flex-col gap-2px'>
                <button type='button' onClick={() => { setEditingId(item.id); setEditingName(item.name); setDeletingId(null); }}>
                  {t('conversation.history.rename')}
                </button>
                <button type='button' disabled={busyId !== null} onClick={() => { void mutate('web-pin', item, { pinned: !item.pinned }); }}>
                  {t(item.pinned ? 'conversation.history.unpin' : 'conversation.history.pin')}
                </button>
                <button type='button' disabled={busyId !== null} onClick={() => { void mutate('web-archive', item); }}>
                  {t('conversation.history.archive')}
                </button>
                <button type='button' onClick={() => { setDeletingId(item.id); setEditingId(null); }}>
                  {t('conversation.history.deleteTitle')}
                </button>
              </div>
            </details>}
          </div>
          {editingId === item.id && <form className='px-10px pb-8px flex gap-4px' onSubmit={(event) => {
            event.preventDefault(); if (editingName.trim()) void mutate('web-rename', item, { name: editingName.trim() });
          }}>
            <input className='min-w-0 flex-1' aria-label={t('conversation.history.renameTitle')} value={editingName}
              maxLength={200} onChange={(event) => setEditingName(event.target.value)} />
            <button type='submit' disabled={!editingName.trim() || busyId !== null}>{t('common.save')}</button>
            <button type='button' onClick={() => setEditingId(null)}>{t('common.cancel')}</button>
          </form>}
          {deletingId === item.id && <div className='px-10px pb-8px text-12px'>
            <span>{t('conversation.history.deleteConfirm')}</span>
            <button type='button' disabled={busyId !== null} onClick={() => { void mutate('web-delete', item); }}>
              {t('conversation.history.deleteTitle')}
            </button>
            <button type='button' onClick={() => setDeletingId(null)}>{t('common.cancel')}</button>
          </div>}
        </div>
      ))}
      {nextCursor && !collapsed && <button type='button' className='w-full px-12px py-8px text-12px text-t-secondary'
        disabled={loadingMore} onClick={() => { void loadMore(); }}>
        {t('conversation.historySearch.loadMore')}
      </button>}
    </section>
  );
};
