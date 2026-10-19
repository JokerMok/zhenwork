import { Button, Message, Modal } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

type EnterpriseApi = { request: (action: string, args: unknown) => Promise<unknown> };
type Resource = { id: string; name: string; version: number; source: string };
type Document = { id: string; title: string; version: number };
type Preview = { filename: string; content: string; version: number };

const api = (): EnterpriseApi | undefined =>
  (window as Window & { enterpriseResources?: EnterpriseApi }).enterpriseResources;

export default function EnterpriseKnowledgePicker({ onAttach }: { onAttach: (path: string, name: string) => void }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [bases, setBases] = useState<Resource[]>([]);
  const [base, setBase] = useState<Resource | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  if (!api()) return null;

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const key = code === 'CONNECTION' ? 'connection' : code === 'PERMISSION' ? 'denied' :
        code === 'FILE_TOO_LARGE' ? 'tooLarge' : code === 'SESSION_CLOSED' ? 'sessionClosed' : 'failed';
      Message.error(t(`fileSelection.enterpriseResources.${key}`));
    } finally {
      setBusy(false);
    }
  };
  const open = () => {
    setVisible(true);
    setBase(null);
    setDocuments([]);
    setPreview(null);
    void run(async () => setBases((await api()!.request('resources', { type: 'KNOWLEDGE' })) as Resource[]));
  };
  const chooseBase = (item: Resource) => {
    setBase(item);
    setPreview(null);
    void run(async () => setDocuments((await api()!.request('documents', { baseId: item.id })) as Document[]));
  };
  const chooseDocument = (item: Document) => {
    void run(async () =>
      setPreview(
        (await api()!.request('preview', {
          baseId: base?.id,
          documentId: item.id,
          version: item.version,
        })) as Preview
      )
    );
  };
  const attach = (item: Document) => {
    void run(async () => {
      const result = (await api()!.request('download', {
        baseId: base?.id,
        documentId: item.id,
        version: item.version,
      })) as {
        path: string;
        name: string;
      };
      onAttach(result.path, result.name);
      setVisible(false);
      Message.success(t('fileSelection.enterpriseResources.attached'));
    });
  };
  const save = (item: Document) => {
    void run(async () => {
      const result = (await api()!.request('save', {
        baseId: base?.id,
        documentId: item.id,
        version: item.version,
      })) as { saved: boolean };
      if (result.saved) Message.success(t('fileSelection.enterpriseResources.saved'));
    });
  };

  return (
    <>
      <Button size='mini' type='text' onClick={open}>
        {t('fileSelection.enterpriseResources.title')}
      </Button>
      <Modal
        visible={visible}
        onCancel={() => setVisible(false)}
        footer={null}
        title={t('fileSelection.enterpriseResources.title')}
      >
        <div className='flex gap-12px' style={{ minHeight: 260, opacity: busy ? 0.65 : 1 }}>
          <div className='flex flex-col gap-6px' style={{ width: 150 }}>
            {bases.map((item) => (
              <Button
                key={item.id}
                size='small'
                type={base?.id === item.id ? 'primary' : 'text'}
                disabled={busy}
                onClick={() => chooseBase(item)}
                title={`${item.source} · v${item.version}`}
              >
                {item.name} · v{item.version}
              </Button>
            ))}
          </div>
          <div className='flex-1 flex flex-col gap-8px'>
            {documents.map((item) => (
              <div key={item.id} className='flex items-center gap-6px'>
                <Button size='small' type='text' disabled={busy} onClick={() => chooseDocument(item)}>
                  {item.title} · v{item.version}
                </Button>
                <Button size='mini' disabled={busy} onClick={() => attach(item)}>
                  {t('fileSelection.enterpriseResources.use')}
                </Button>
                <Button size='mini' disabled={busy} onClick={() => save(item)}>
                  {t('fileSelection.enterpriseResources.save')}
                </Button>
              </div>
            ))}
            {preview && (
              <pre className='overflow-auto p-8px bg-fill-1' style={{ maxHeight: 240, whiteSpace: 'pre-wrap' }}>
                {preview.content}
              </pre>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
