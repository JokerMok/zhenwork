import { Alert, Avatar, Button, Input, Modal, Select, Spin, Switch } from '@arco-design/web-react';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enterpriseRequest, WorkspaceApiError, workspaceErrorTranslationKey } from './workspace/workspaceApi';

type Section = 'profile' | 'personalization';
type Profile = {
  id: string;
  username: string;
  nickname: string;
  department?: string;
  position?: string;
  avatarUrl?: string;
};
type Preferences = {
  version: number;
  enabled: boolean;
  style: string;
  detail: string;
  language: string;
  instructions: string;
};
type PersonalData =
  | { section: 'profile'; profile: Profile; nickname: string }
  | { section: 'personalization'; original: Preferences; draft: Preferences };

const profileRoute = '/enterprise/self-profile';
const preferencesRoute = '/enterprise/preferences';
const passwordRoute = '/enterprise/self-password';
const defaultPreferences = { enabled: false, style: '', detail: '', language: '', instructions: '' };
const emptyPasswords = { oldPassword: '', newPassword: '', confirmation: '' };
const passwordPolicy = /^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{8,16}$/;
const replyLanguages = ['zh-CN', 'en-US', 'zh-TW', 'ja-JP', 'ko-KR'];
const errorCode = (error: unknown) => (error instanceof WorkspaceApiError ? error.code : 'REQUEST_FAILED');

const send = <T,>(route: string, method: 'PUT' | 'POST', payload: object) =>
  enterpriseRequest<T>(route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

export default function EnterprisePersonalSettings({ section }: { section: Section }) {
  const { t, i18n } = useTranslation();
  const { clearAuthCache } = useAuth();
  const [data, setData] = useState<PersonalData>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwords, setPasswords] = useState(emptyPasswords);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const generation = useRef(0);
  const loadRequest = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const passwordSubmitting = useRef(false);

  const load = useCallback(async () => {
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    const current = ++generation.current;
    setData(undefined);
    setLoading(true);
    setError('');
    setSaved(false);
    try {
      if (section === 'profile') {
        const profile = await enterpriseRequest<Profile>(profileRoute, { signal: controller.signal });
        if (!profile?.id || !profile.username || typeof profile.nickname !== 'string')
          throw new Error('INVALID_PROFILE');
        if (current === generation.current) setData({ section, profile, nickname: profile.nickname });
      } else {
        const original = await enterpriseRequest<Preferences>(preferencesRoute, { signal: controller.signal });
        if (
          !Number.isInteger(original?.version) ||
          typeof original.enabled !== 'boolean' ||
          [original.style, original.detail, original.language, original.instructions].some(
            (value) => typeof value !== 'string'
          )
        ) {
          throw new Error('INVALID_PREFERENCES');
        }
        if (current === generation.current) setData({ section, original, draft: original });
      }
    } catch (cause) {
      if (current === generation.current) setError(errorCode(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [section]);

  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
      loadRequest.current?.abort();
    };
  }, [load]);

  const active = data?.section === section ? data : undefined;
  const dirty =
    active?.section === 'profile'
      ? active.nickname !== active.profile.nickname
      : active?.section === 'personalization' &&
        (Object.keys(defaultPreferences) as Array<keyof typeof defaultPreferences>).some(
          (key) => active.original[key] !== active.draft[key]
        );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const editPreferences = (next: Partial<Preferences>) => {
    setData((current) =>
      current?.section === 'personalization' ? { ...current, draft: { ...current.draft, ...next } } : current
    );
    setSaved(false);
  };

  const save = async () => {
    if (!active || !dirty || submitting.current) return;
    const current = generation.current;
    submitting.current = true;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      if (active.section === 'profile') {
        const profile = await send<Profile>(profileRoute, 'PUT', { nickname: active.nickname.trim() });
        window.dispatchEvent(new CustomEvent('enterprise-profile-updated'));
        if (current === generation.current) setData({ section: 'profile', profile, nickname: profile.nickname });
      } else {
        const { version: expectedVersion, ...draft } = active.draft;
        const original = await send<Preferences>(preferencesRoute, 'PUT', { ...draft, expectedVersion });
        if (current === generation.current) setData({ section: 'personalization', original, draft: original });
      }
      if (current === generation.current) setSaved(true);
    } catch (cause) {
      if (current === generation.current) setError(errorCode(cause));
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  const closePassword = () => {
    setPasswords(emptyPasswords);
    setPasswordError('');
    setPasswordOpen(false);
  };

  const changePassword = async () => {
    if (passwordSubmitting.current) return;
    const { oldPassword, newPassword, confirmation } = passwords;
    if (!oldPassword || !passwordPolicy.test(newPassword) || newPassword !== confirmation) {
      setPasswordError(t('settings.enterpriseAccount.passwordInvalid'));
      return;
    }
    passwordSubmitting.current = true;
    setPasswordBusy(true);
    setPasswordError('');
    try {
      await send(passwordRoute, 'POST', { oldPassword, newPassword });
      closePassword();
      clearAuthCache();
      window.location.replace('/enterprise/login');
    } catch {
      setPasswordError(t('settings.enterpriseAccount.passwordFailed'));
    } finally {
      passwordSubmitting.current = false;
      setPasswordBusy(false);
    }
  };

  const conflict = ['PREFS_VERSION_CONFLICT', 'HTTP_409'].includes(error);
  const label = (key: 'style' | 'detail' | 'replyLanguage' | 'instructions') => t(`settings.enterpriseAccount.${key}`);
  const names = new Intl.DisplayNames([i18n.resolvedLanguage || 'en-US'], { type: 'language' });
  const displayName = active?.section === 'profile' ? active.profile.nickname || active.profile.username : '';
  const avatar =
    active?.section === 'profile' && active.profile.avatarUrl?.startsWith('https://')
      ? active.profile.avatarUrl
      : undefined;

  return (
    <section className='mx-auto max-w-720px px-20px py-24px md:px-32px' aria-labelledby='enterprise-personal-title'>
      <h1 id='enterprise-personal-title' className='text-24px font-600 mt-0 mb-20px'>
        {t(section === 'profile' ? 'settings.enterpriseAccount.profile' : 'settings.enterpriseAccount.personalization')}
      </h1>
      {loading && (
        <div role='status' className='py-28px'>
          <Spin />
        </div>
      )}
      {error && (
        <Alert
          type='error'
          className='mb-16px'
          content={
            conflict
              ? t('settings.enterpriseAccount.conflict')
              : t(workspaceErrorTranslationKey(error, active ? 'action' : 'load'), { code: error })
          }
          action={
            !active || conflict ? (
              <Button size='small' onClick={() => void load()}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      )}
      {active?.section === 'profile' && (
        <>
          <div className='flex items-center gap-12px mb-20px'>
            <Avatar size={44}>
              {avatar ? <img src={avatar} alt='' referrerPolicy='no-referrer' /> : [...displayName][0]?.toUpperCase()}
            </Avatar>
            <span className='text-16px font-600'>{displayName}</span>
          </div>
          <dl className='grid grid-cols-[auto_1fr] gap-x-24px gap-y-10px mb-20px'>
            <dt>{t('login.enterpriseAccountLabel')}</dt>
            <dd className='m-0'>{active.profile.username}</dd>
            {active.profile.department && (
              <>
                <dt>{t('settings.enterpriseAccount.department')}</dt>
                <dd className='m-0'>{active.profile.department}</dd>
              </>
            )}
            {active.profile.position && (
              <>
                <dt>{t('settings.enterpriseAccount.position')}</dt>
                <dd className='m-0'>{active.profile.position}</dd>
              </>
            )}
          </dl>
          <label className='block mb-6px' htmlFor='enterprise-nickname'>
            {t('settings.enterpriseAccount.nickname')}
          </label>
          <Input
            id='enterprise-nickname'
            value={active.nickname}
            maxLength={30}
            disabled={saving}
            onChange={(nickname) => {
              setData({ ...active, nickname });
              setSaved(false);
            }}
          />
        </>
      )}
      {active?.section === 'personalization' && (
        <div className='flex flex-col gap-16px'>
          <div className='flex items-center justify-between gap-12px'>
            <span id='enterprise-preferences-enable'>{t('settings.enterpriseAccount.enable')}</span>
            <Switch
              aria-labelledby='enterprise-preferences-enable'
              checked={active.draft.enabled}
              disabled={saving}
              onChange={(enabled) => editPreferences({ enabled })}
            />
          </div>
          <div className='grid grid-cols-1 sm:grid-cols-3 gap-12px'>
            <div>
              <label className='block mb-6px' id='enterprise-reply-style'>
                {label('style')}
              </label>
              <Select
                value={active.draft.style}
                disabled={saving}
                aria-labelledby='enterprise-reply-style'
                onChange={(style: string) => editPreferences({ style })}
              >
                <Select.Option value=''>{t('common.default')}</Select.Option>
                <Select.Option value='neutral'>{t('settings.enterpriseAccount.neutral')}</Select.Option>
                <Select.Option value='direct'>{t('settings.enterpriseAccount.direct')}</Select.Option>
                <Select.Option value='friendly'>{t('settings.enterpriseAccount.friendly')}</Select.Option>
              </Select>
            </div>
            <div>
              <label className='block mb-6px' id='enterprise-reply-detail'>
                {label('detail')}
              </label>
              <Select
                value={active.draft.detail}
                disabled={saving}
                aria-labelledby='enterprise-reply-detail'
                onChange={(detail: string) => editPreferences({ detail })}
              >
                <Select.Option value=''>{t('common.default')}</Select.Option>
                <Select.Option value='brief'>{t('settings.enterpriseAccount.brief')}</Select.Option>
                <Select.Option value='balanced'>{t('settings.enterpriseAccount.balanced')}</Select.Option>
                <Select.Option value='detailed'>{t('settings.enterpriseAccount.detailed')}</Select.Option>
              </Select>
            </div>
            <div>
              <label className='block mb-6px' id='enterprise-reply-language'>
                {label('replyLanguage')}
              </label>
              <Select
                value={active.draft.language}
                disabled={saving}
                aria-labelledby='enterprise-reply-language'
                onChange={(language: string) => editPreferences({ language })}
              >
                <Select.Option value=''>{t('common.default')}</Select.Option>
                {replyLanguages.map((language) => (
                  <Select.Option key={language} value={language}>
                    {names.of(language)}
                  </Select.Option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <label className='block mb-6px' htmlFor='enterprise-instructions'>
              {label('instructions')}
            </label>
            <Input.TextArea
              id='enterprise-instructions'
              value={active.draft.instructions}
              disabled={saving}
              maxLength={2000}
              showWordLimit
              autoSize={{ minRows: 4, maxRows: 10 }}
              onChange={(instructions) => editPreferences({ instructions })}
            />
          </div>
        </div>
      )}
      {active && (
        <div className='flex flex-wrap items-center gap-10px mt-16px'>
          <Button type='primary' loading={saving} disabled={!dirty} onClick={() => void save()}>
            {t('common.save')}
          </Button>
          {active.section === 'personalization' && (
            <Button disabled={saving} onClick={() => editPreferences(defaultPreferences)}>
              {t('settings.enterpriseAccount.reset')}
            </Button>
          )}
          {dirty && (
            <span role='status' className='text-t-secondary'>
              {t('settings.enterpriseAccount.unsaved')}
            </span>
          )}
          {saved && (
            <span role='status' className='text-t-secondary'>
              {t('settings.enterpriseAccount.saved')}
            </span>
          )}
        </div>
      )}
      {active?.section === 'profile' && (
        <div className='mt-28px'>
          <Button onClick={() => setPasswordOpen(true)}>{t('settings.enterpriseAccount.changePassword')}</Button>
        </div>
      )}
      <Modal
        visible={passwordOpen && section === 'profile'}
        title={t('settings.enterpriseAccount.changePassword')}
        onCancel={passwordBusy ? undefined : closePassword}
        onOk={() => void changePassword()}
        confirmLoading={passwordBusy}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        maskClosable={!passwordBusy}
        escToExit={!passwordBusy}
      >
        {passwordError && <Alert type='error' content={passwordError} className='mb-12px' />}
        <div className='flex flex-col gap-12px'>
          {(
            [
              ['oldPassword', 'login.password', 'current-password'],
              ['newPassword', 'login.passwordFlow.newPassword', 'new-password'],
              ['confirmation', 'login.passwordFlow.confirmPassword', 'new-password'],
            ] as const
          ).map(([field, text, autocomplete]) => (
            <div key={field}>
              <label className='block mb-6px' htmlFor={`enterprise-${field}`}>
                {t(text)}
              </label>
              <Input.Password
                id={`enterprise-${field}`}
                autoComplete={autocomplete}
                value={passwords[field]}
                disabled={passwordBusy}
                onChange={(value) => setPasswords((current) => ({ ...current, [field]: value }))}
              />
            </div>
          ))}
        </div>
      </Modal>
    </section>
  );
}
