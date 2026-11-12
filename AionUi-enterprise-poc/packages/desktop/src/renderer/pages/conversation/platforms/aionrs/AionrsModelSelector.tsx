/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { enterpriseModelBlockKey, type AionrsModelSelection } from './useAionrsModelSelection';
import type { AcpConfigSetStatus, AcpDerivedOption } from '@/renderer/hooks/agent/useAcpConfigOptions';
import {
  composeRuntimeSelectorLabel,
  getCurrentThoughtLevelLabel,
  RUNTIME_SUBMENU_TRIGGER_PROPS,
  RuntimeSelectorCheckedItem,
  RuntimeSelectorModelList,
  type RuntimeSelectorModelGroup,
  RuntimeSelectorSubMenuTitle,
} from '@/renderer/components/agent/runtimeSelectorOptions';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { getModelDisplayLabel } from '@/renderer/utils/model/agentLogo';
import { iconColors } from '@/renderer/styles/colors';
import { Button, Dropdown, Menu, Tooltip } from '@arco-design/web-react';
import { Brain, Down } from '@icon-park/react';
import React, { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import classNames from 'classnames';

/** Composite id for a provider+model pair, so the shared flat model list can track selection. */
const compositeId = (providerId: string, modelName: string) => `${providerId}::${modelName}`;

export const EnterpriseModelSelector: React.FC<{
  selection: AionrsModelSelection;
  catalog: NonNullable<AionrsModelSelection['enterpriseCatalog']>;
  busy: boolean;
}> = ({ selection, catalog, busy }) => {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const { current_model, providers, getAvailableModels, handleSelectModel } = selection;
  const currentCode = current_model?.use_model;
  const currentLabel = selection.getDisplayModelName(currentCode) || t('conversation.welcome.selectModel');
  const provider = providers[0];
  const codes = provider ? getAvailableModels(provider) : [];
  const counts = new Map<string, number>();
  for (const code of codes) {
    const name = selection.getDisplayModelName(code);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const missingModels = (catalog.authorizedCount ?? 0) > codes.length;
  const switchDisabled = busy || catalog.refreshing || catalog.failed || catalog.switching;
  const statusClass = 'w-320px max-w-[calc(100vw-32px)] !h-auto !whitespace-normal !leading-5 py-6px';
  const getTrigger = () => document.getElementById(`${id}-trigger`);
  const refresh = (): void => {
    void catalog.refresh(!busy && !catalog.isSwitching());
  };

  const handleVisibilityChange = (visible: boolean) => {
    setOpen(visible);
    if (visible) {
      refresh();
      requestAnimationFrame(() => document.getElementById(`${id}-refresh`)?.focus());
    }
  };

  return (
    <Dropdown
      trigger='click'
      position='tl'
      popupVisible={open}
      onVisibleChange={handleVisibilityChange}
      getPopupContainer={() => document.body}
      droplist={
        <Menu
          id={id}
          className='max-h-[min(60vh,420px)] overflow-y-auto'
          onClickMenuItem={() => false}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setOpen(false);
            getTrigger()?.focus();
          }}
        >
          <Menu.Item key='refresh' id={`${id}-refresh`} onClick={refresh} disabled={catalog.refreshing}>
            {catalog.failed || catalog.refreshFailed ? t('common.retry') : t('common.refresh')}
          </Menu.Item>
          {catalog.sendBlock && (
            <Menu.Item key='availability' disabled className={statusClass}>
              <span role='status'>{t(enterpriseModelBlockKey[catalog.sendBlock])}</span>
            </Menu.Item>
          )}
          {catalog.refreshFailed && !catalog.failed && (
            <Menu.Item key='refresh-failed' disabled className={statusClass}>
              <span role='status'>{t('workspace.modelAvailability.pending')}</span>
            </Menu.Item>
          )}
          {missingModels &&
            !catalog.failed &&
            !catalog.refreshFailed &&
            !catalog.refreshing &&
            catalog.sendBlock !== 'pending' && (
              <Menu.Item key='pending-models' disabled className={statusClass}>
                {t('workspace.modelAvailability.pending')}
              </Menu.Item>
            )}
          {busy && (
            <Menu.Item key='busy' disabled className={statusClass}>
              {t('workspace.modelAvailability.busy')}
            </Menu.Item>
          )}
          {catalog.switchFailed && (
            <Menu.Item key='switch-failed' disabled className={statusClass}>
              <span role='status'>{t('agent.model.switchFailed')}</span>
            </Menu.Item>
          )}
          {provider &&
            codes.map((code) => {
              const model = catalog.models.get(code);
              const name = selection.getDisplayModelName(code);
              const selected = current_model?.id === provider.id && currentCode === code;
              const duplicate = (counts.get(name) ?? 0) > 1;
              const duplicateCode =
                duplicate &&
                codes.some(
                  (other) =>
                    other !== code &&
                    selection.getDisplayModelName(other) === name &&
                    catalog.models.get(other)?.code === model?.code
                );
              const description = duplicate ? (duplicateCode ? model?.id : model?.code || model?.id) : undefined;
              return (
                <Menu.Item
                  key={code}
                  disabled={switchDisabled}
                  role='menuitemradio'
                  aria-checked={selected}
                  className={statusClass}
                  onClick={() => {
                    if (!switchDisabled && !selected) void handleSelectModel(provider, code);
                  }}
                >
                  <div className='flex gap-8px'>
                    <span aria-hidden='true' className='w-16px shrink-0 text-primary'>
                      {selected ? '✓' : ''}
                    </span>
                    <div className='min-w-0 break-words'>
                      <div>{name}</div>
                      {description && <div className='text-12px text-t-secondary'>{description}</div>}
                      {model?.isDefault && (
                        <div className='text-12px text-t-secondary'>{t('workspace.abilities.default')}</div>
                      )}
                    </div>
                  </div>
                </Menu.Item>
              );
            })}
          {!catalog.sendBlock && !catalog.failed && codes.length === 1 && catalog.authorizedCount === 1 && (
            <Menu.Item key='single' disabled className={statusClass}>
              {t('workspace.modelAvailability.single')}
            </Menu.Item>
          )}
        </Menu>
      }
    >
      <Button
        id={`${id}-trigger`}
        data-testid='aionrs-model-selector'
        aria-label={`${t('common.model')}: ${currentLabel}`}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={currentLabel}
        className='sendbox-model-btn !max-w-[min(35vw,208px)] shrink-0'
        shape='round'
        size='small'
      >
        <span className='flex items-center gap-6px min-w-0'>
          <Brain theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />
          <span className='block truncate'>{currentLabel}</span>
          <Down theme='outline' size={12} fill={iconColors.secondary} className='shrink-0' />
        </span>
      </Button>
    </Dropdown>
  );
};

const AionrsModelSelector: React.FC<{
  selection?: AionrsModelSelection;
  disabled?: boolean;
  busy?: boolean;
  thoughtLevel?: AcpDerivedOption | null;
  /** Kept for call-site compatibility; the two-level submenu no longer gates on set status here. */
  setStatus?: AcpConfigSetStatus;
  onSetThoughtLevel?: (optionId: string, value: string) => Promise<unknown>;
}> = ({ selection, disabled = false, busy = false, thoughtLevel = null, onSetThoughtLevel }) => {
  const { t } = useTranslation();
  const { isOpen: isPreviewOpen } = usePreviewContext();
  const layout = useLayoutContext();
  const compact = isPreviewOpen || layout?.isMobile;
  const isMobileHeaderCompact = Boolean(layout?.isMobile);
  const defaultModelLabel = t('common.defaultModel');

  const current_model = selection?.current_model;

  const renderLogo = () => <Brain theme='outline' size='14' fill={iconColors.secondary} className='shrink-0' />;

  if (!disabled && selection?.enterpriseCatalog) {
    return <EnterpriseModelSelector selection={selection} catalog={selection.enterpriseCatalog} busy={busy} />;
  }

  if (disabled || !selection) {
    return (
      <Tooltip content={t('conversation.welcome.modelSwitchNotSupported')} position='top'>
        <Button
          className={classNames(
            'sendbox-model-btn header-model-btn',
            compact && '!max-w-[120px]',
            isMobileHeaderCompact && '!max-w-[160px]'
          )}
          shape='round'
          size='small'
          style={{ cursor: 'default' }}
        >
          <span className='flex items-center gap-6px min-w-0'>
            {renderLogo()}
            <span className={compact ? 'block truncate' : undefined}>{t('conversation.welcome.useCliModel')}</span>
          </span>
        </Button>
      </Tooltip>
    );
  }

  const { providers, getAvailableModels, handleSelectModel } = selection;

  const label = getModelDisplayLabel({
    selected_value: selection.getDisplayModelName(current_model?.use_model),
    selectedLabel: selection.getDisplayModelName(current_model?.use_model),
    defaultModelLabel,
    fallbackLabel: t('conversation.welcome.selectModel'),
  });
  const combinedLabel = composeRuntimeSelectorLabel({ modelLabel: label, thoughtLevel });
  const handleThoughtLevelSelect = (value: string) => {
    if (!thoughtLevel || value === thoughtLevel.currentValue || !onSetThoughtLevel) return;
    void onSetThoughtLevel(thoughtLevel.id, value);
  };

  // aionrs models are grouped by provider. Use a composite id (see compositeId)
  // so the shared model list can track selection, and map it back on select.
  const modelGroups: RuntimeSelectorModelGroup[] = [];
  const modelLookup = new Map<string, { provider: (typeof providers)[number]; modelName: string }>();
  for (const provider of providers) {
    const models = getAvailableModels(provider);
    if (!models.length) continue;
    modelGroups.push({
      key: provider.id,
      title: provider.name,
      models: models.map((modelName) => {
        const id = compositeId(provider.id, modelName);
        modelLookup.set(id, { provider, modelName });
        return { id, label: selection.getDisplayModelName(modelName) };
      }),
    });
  }
  const currentCompositeId = current_model ? compositeId(current_model.id, current_model.use_model || '') : null;
  const handleModelSelect = (id: string) => {
    const entry = modelLookup.get(id);
    if (entry) void handleSelectModel(entry.provider, entry.modelName);
  };

  const modelListNode = (
    <RuntimeSelectorModelList groups={modelGroups} currentModelId={currentCompositeId} onSelect={handleModelSelect} />
  );

  return (
    <Dropdown
      trigger='click'
      // Mobile: portal the popup to <body> so it escapes the titlebar slot.
      // Desktop: leave default container so click events reach Menu.Item normally.
      {...(isMobileHeaderCompact ? { getPopupContainer: () => document.body } : {})}
      droplist={
        <Menu>
          {thoughtLevel ? (
            <>
              <Menu.SubMenu
                key='model'
                triggerProps={RUNTIME_SUBMENU_TRIGGER_PROPS}
                title={
                  <RuntimeSelectorSubMenuTitle label={t('common.model', { defaultValue: 'Model' })} value={label} />
                }
              >
                {modelListNode}
              </Menu.SubMenu>
              <Menu.SubMenu
                key='thought-level'
                triggerProps={RUNTIME_SUBMENU_TRIGGER_PROPS}
                title={
                  <RuntimeSelectorSubMenuTitle
                    label={t('agent.thoughtLevel.label')}
                    value={getCurrentThoughtLevelLabel(thoughtLevel)}
                  />
                }
              >
                {thoughtLevel.options.map((item) => (
                  <Menu.Item
                    key={item.value}
                    className={item.value === thoughtLevel.currentValue ? '!bg-2' : ''}
                    onClick={() => handleThoughtLevelSelect(item.value)}
                  >
                    <RuntimeSelectorCheckedItem
                      selected={item.value === thoughtLevel.currentValue}
                      description={item.description}
                    >
                      {item.label}
                    </RuntimeSelectorCheckedItem>
                  </Menu.Item>
                ))}
              </Menu.SubMenu>
            </>
          ) : (
            modelListNode
          )}
        </Menu>
      }
    >
      <Button
        data-testid='aionrs-model-selector'
        className={classNames(
          'sendbox-model-btn header-model-btn',
          compact && '!max-w-[120px]',
          isMobileHeaderCompact && '!max-w-[160px]'
        )}
        shape='round'
        size='small'
      >
        <span className='flex items-center gap-6px min-w-0'>
          {renderLogo()}
          <span className={compact ? 'block truncate' : undefined}>{combinedLabel}</span>
          <Down theme='outline' size={12} fill={iconColors.secondary} className='shrink-0' />
        </span>
      </Button>
    </Dropdown>
  );
};

export default AionrsModelSelector;
