/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import AionrsModelSelector from '@/renderer/pages/conversation/platforms/aionrs/AionrsModelSelector';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import type { AcpDerivedOption } from '@/renderer/hooks/agent/useAcpConfigOptions';
import {
  useAionrsModelSelection,
  type AionrsModelSelection,
} from '@/renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';
import { SWRConfig } from 'swr';

const provider: IProvider = {
  id: 'openai',
  name: 'OpenAI',
  platform: 'openai',
  use_model: 'gpt-5.2',
  models: ['gpt-5.2', 'gpt-5.2-mini'],
} as IProvider;

const managedProvider = { ...provider, id: 'rc2-enterprise-model', models: ['rc2-terra', 'rc2-astra'] };
const catalogModels = [
  { id: 'terra', code: 'terra', name: 'GPT-6.1-Terra', isDefault: true, streaming: true },
  { id: 'astra', code: 'astra', name: 'GPT-6-Astra', streaming: true },
];

const { readModels, refreshResources, enterpriseWeb } = vi.hoisted(() => ({
  readModels: vi.fn(),
  refreshResources: vi.fn(),
  enterpriseWeb: vi.fn(() => false),
}));
vi.mock('@/renderer/utils/platform', () => ({ isEnterpriseWeb: enterpriseWeb }));
vi.mock('@/renderer/pages/workspace/workspaceApi', () => ({
  enterpriseControl: readModels,
  enterpriseRequest: refreshResources,
}));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  PROVIDERS_SWR_KEY: 'providers',
  useModelProviderList: () => ({
    providers: [managedProvider],
    getAvailableModels: (value: IProvider) => value.models ?? [],
  }),
}));

const thoughtLevel: AcpDerivedOption = {
  id: 'reasoning_effort',
  category: 'thought_level',
  currentValue: 'high',
  options: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
  ],
};

const makeSelection = (overrides: Partial<AionrsModelSelection> = {}): AionrsModelSelection => ({
  current_model: {
    ...provider,
    use_model: 'gpt-5.2',
  } as TProviderWithModel,
  providers: [provider],
  getAvailableModels: () => ['gpt-5.2', 'gpt-5.2-mini'],
  handleSelectModel: vi.fn().mockResolvedValue(undefined),
  getDisplayModelName: (modelName?: string) => modelName ?? '',
  ...overrides,
});

const makeEnterpriseCatalog = (
  overrides: Partial<NonNullable<AionrsModelSelection['enterpriseCatalog']>> = {}
): NonNullable<AionrsModelSelection['enterpriseCatalog']> => ({
  models: new Map(catalogModels.map((model) => [`rc2-${model.id}`, model])),
  authorizedCount: 1,
  failed: false,
  refreshFailed: false,
  refreshing: false,
  switching: false,
  switchFailed: false,
  sendBlock: undefined,
  refresh: vi.fn().mockResolvedValue(undefined),
  isSwitching: () => false,
  ...overrides,
});

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ isOpen: false }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/utils/model/agentLogo', () => ({
  getModelDisplayLabel: ({
    selectedLabel,
    selected_value,
    fallbackLabel,
  }: {
    selectedLabel?: string;
    selected_value?: string | null;
    fallbackLabel: string;
  }) => selectedLabel || selected_value || fallbackLabel,
}));

vi.mock('@icon-park/react', () => ({
  Brain: () => <span aria-hidden='true'>brain</span>,
  Down: () => <span aria-hidden='true'>v</span>,
  Search: () => <span aria-hidden='true'>search</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      if (key === 'agent.thoughtLevel.label') return 'Thinking Level';
      if (key === 'common.model') return 'Model';
      if (key === 'conversation.welcome.selectModel') return 'Select model';
      if (key === 'conversation.welcome.useCliModel') return 'Use CLI model';
      if (key === 'conversation.welcome.modelSwitchNotSupported') return 'Model switch is not supported';
      if (key === 'common.defaultModel') return 'Default';
      if (key === 'agent.model.searchPlaceholder') return 'Search models';
      if (key === 'agent.model.noResults') return 'No matching models';
      return options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@arco-design/web-react', () => {
  const Menu = Object.assign(
    ({ children }: { children?: React.ReactNode; className?: string }) => (
      <div data-testid='dropdown-menu'>{children}</div>
    ),
    {
      Item: ({
        children,
        className,
        onClick,
        role = 'menuitem',
        disabled,
      }: {
        children?: React.ReactNode;
        className?: string;
        onClick?: () => void;
        role?: string;
        disabled?: boolean;
      }) => (
        <div role={role} className={className} onClick={disabled ? undefined : onClick} aria-disabled={disabled}>
          {children}
        </div>
      ),
      ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
        <div role='group' aria-label={String(title)}>
          {children}
        </div>
      ),
      SubMenu: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
        <div role='group'>
          <div data-testid='submenu-title'>{title}</div>
          <div data-testid='submenu-body'>{children}</div>
        </div>
      ),
    }
  );
  return {
    Button: ({
      children,
      disabled,
      onClick,
      ...props
    }: {
      children?: React.ReactNode;
      disabled?: boolean;
      onClick?: () => void;
      [key: string]: unknown;
    }) => (
      <button type='button' disabled={disabled} onClick={onClick} {...props}>
        {children}
      </button>
    ),
    Dropdown: ({
      children,
      droplist,
      onVisibleChange,
    }: {
      children: React.ReactElement<{ onClick?: () => void }>;
      droplist?: React.ReactNode;
      onVisibleChange?: (visible: boolean) => void;
    }) => (
      <div>
        {React.cloneElement(children, { onClick: () => onVisibleChange?.(true) })}
        {droplist}
      </div>
    ),
    Menu,
    Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

describe('AionrsModelSelector runtime options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the only authorized model without switching when it is selected again', () => {
    const selection = makeSelection({
      providers: [managedProvider],
      current_model: { ...managedProvider, use_model: 'rc2-terra' } as TProviderWithModel,
      getAvailableModels: () => ['rc2-terra'],
      getDisplayModelName: () => 'GPT-6.1-Terra',
      enterpriseCatalog: makeEnterpriseCatalog(),
    });
    render(<AionrsModelSelector selection={selection} />);
    expect(screen.getByRole('button', { name: /GPT-6.1-Terra/ })).toBeInTheDocument();
    expect(screen.getByText('workspace.modelAvailability.single')).toBeInTheDocument();
    expect(screen.getByText('workspace.abilities.default')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-6.1-Terra/ }));
    expect(selection.handleSelectModel).not.toHaveBeenCalled();
  });

  it('shows a catalog failure separately from the absence of authorization', () => {
    const { rerender } = render(
      <AionrsModelSelector
        selection={makeSelection({
          providers: [],
          enterpriseCatalog: makeEnterpriseCatalog({ failed: true, sendBlock: 'failed' }),
        })}
      />
    );
    expect(screen.getByText('workspace.modelAvailability.failed')).toBeInTheDocument();
    rerender(
      <AionrsModelSelector
        selection={makeSelection({
          providers: [],
          enterpriseCatalog: makeEnterpriseCatalog({ authorizedCount: 0, sendBlock: 'empty' }),
        })}
      />
    );
    expect(screen.getByText('workspace.errors.noModel')).toBeInTheDocument();
  });

  it('refreshes on open and provides a retry action after a read failure', () => {
    const catalog = makeEnterpriseCatalog({ failed: true, sendBlock: 'failed' });
    render(<AionrsModelSelector selection={makeSelection({ providers: [], enterpriseCatalog: catalog })} />);
    fireEvent.click(screen.getByRole('button', { name: /Model/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'common.retry' }));
    expect(catalog.refresh).toHaveBeenCalledTimes(2);
  });

  it('allows a catalog read while busy and blocks selecting another model', () => {
    const catalog = makeEnterpriseCatalog({ authorizedCount: 2 });
    const selection = makeSelection({
      providers: [managedProvider],
      current_model: { ...managedProvider, use_model: 'rc2-terra' },
      getAvailableModels: () => ['rc2-terra', 'rc2-astra'],
      getDisplayModelName: (code) => catalog.models.get(code ?? '')?.name ?? '',
      enterpriseCatalog: catalog,
    });
    render(<AionrsModelSelector selection={selection} busy />);
    fireEvent.click(screen.getByRole('button', { name: /GPT-6.1-Terra/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /GPT-6-Astra/ }));
    expect(catalog.refresh).toHaveBeenCalledWith(false);
    expect(screen.getByText('workspace.modelAvailability.busy')).toBeInTheDocument();
    expect(selection.handleSelectModel).not.toHaveBeenCalled();
  });

  it('shows the current model and thought level in the header pill', () => {
    render(
      <AionrsModelSelector
        selection={makeSelection()}
        thoughtLevel={thoughtLevel}
        setStatus={{ state: 'idle' }}
        onSetThoughtLevel={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByTestId('aionrs-model-selector')).toHaveTextContent('gpt-5.2 · High');
  });

  it('shows the model submenu before the thought level submenu, each with its current value', () => {
    render(
      <AionrsModelSelector
        selection={makeSelection()}
        thoughtLevel={thoughtLevel}
        setStatus={{ state: 'idle' }}
        onSetThoughtLevel={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const titles = screen.getAllByTestId('submenu-title');
    expect(titles[0]).toHaveTextContent('Model');
    expect(titles[0]).toHaveTextContent('gpt-5.2');
    expect(titles[1]).toHaveTextContent('Thinking Level');
    expect(titles[1]).toHaveTextContent('High');
  });

  it('keeps provider grouping inside the model submenu', () => {
    render(
      <AionrsModelSelector
        selection={makeSelection()}
        thoughtLevel={thoughtLevel}
        setStatus={{ state: 'idle' }}
        onSetThoughtLevel={vi.fn().mockResolvedValue(undefined)}
      />
    );

    // The provider group title (OpenAI) is rendered inside the model submenu.
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeInTheDocument();
  });

  it('marks the current model with the leading check indicator', () => {
    render(
      <AionrsModelSelector
        selection={makeSelection()}
        thoughtLevel={thoughtLevel}
        setStatus={{ state: 'idle' }}
        onSetThoughtLevel={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const providerGroup = screen.getByRole('group', { name: 'OpenAI' });
    const currentModelItem = within(providerGroup).getByText('gpt-5.2').closest('[role="menuitem"]');
    const otherModelItem = within(providerGroup).getByText('gpt-5.2-mini').closest('[role="menuitem"]');

    expect(currentModelItem?.textContent?.trim().startsWith('✓')).toBe(true);
    expect(otherModelItem).not.toHaveTextContent('✓');
  });

  it('selects a model through the selection callback', () => {
    const handleSelectModel = vi.fn().mockResolvedValue(undefined);
    render(
      <AionrsModelSelector
        selection={makeSelection({ handleSelectModel })}
        thoughtLevel={thoughtLevel}
        setStatus={{ state: 'idle' }}
        onSetThoughtLevel={vi.fn().mockResolvedValue(undefined)}
      />
    );

    fireEvent.click(screen.getByText('gpt-5.2-mini'));

    expect(handleSelectModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'openai' }), 'gpt-5.2-mini');
  });

  it('renders the model list directly (no submenu) when thought level is unavailable', () => {
    render(<AionrsModelSelector selection={makeSelection()} />);

    expect(screen.getByTestId('aionrs-model-selector')).toHaveTextContent('gpt-5.2');
    expect(screen.queryAllByTestId('submenu-title')).toHaveLength(0);
    // Still grouped by provider even without a submenu wrapper.
    expect(screen.getByRole('group', { name: 'OpenAI' })).toBeInTheDocument();
  });

  it('sets thought level through the optional runtime callback', async () => {
    const onSetThoughtLevel = vi.fn().mockResolvedValue(undefined);

    render(
      <AionrsModelSelector
        selection={makeSelection()}
        thoughtLevel={thoughtLevel}
        setStatus={{ state: 'idle' }}
        onSetThoughtLevel={onSetThoughtLevel}
      />
    );

    fireEvent.click(screen.getByText('Low'));

    await waitFor(() => {
      expect(onSetThoughtLevel).toHaveBeenCalledWith('reasoning_effort', 'low');
    });
  });
});

describe('Enterprise conversation model selection', () => {
  const initialModel = { ...managedProvider, use_model: 'rc2-terra' };
  const wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
  );

  beforeEach(() => {
    enterpriseWeb.mockReturnValue(true);
    readModels.mockReset().mockResolvedValue(catalogModels);
  });

  it('keeps the previous selection when persistence fails', async () => {
    const onSelectModel = vi.fn().mockRejectedValue(new Error('update failed'));
    const { result } = renderHook(() => useAionrsModelSelection({ initialModel, onSelectModel }), { wrapper });
    await waitFor(() => expect(result.current.enterpriseCatalog?.sendBlock).toBeUndefined());
    await act(() => result.current.handleSelectModel(managedProvider, 'rc2-astra'));
    expect(result.current.current_model?.use_model).toBe('rc2-terra');
    expect(result.current.enterpriseCatalog?.switchFailed).toBe(true);
  });

  it('selects the authorized model by its stable code after persistence succeeds', async () => {
    const onSelectModel = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useAionrsModelSelection({ initialModel, onSelectModel }), { wrapper });
    await waitFor(() => expect(result.current.enterpriseCatalog?.sendBlock).toBeUndefined());
    await act(() => result.current.handleSelectModel(managedProvider, 'rc2-astra'));
    expect(onSelectModel).toHaveBeenCalledWith(managedProvider, 'rc2-astra');
    expect(result.current.current_model?.use_model).toBe('rc2-astra');
  });

  it('requires a new selection after access is revoked, even if another model is available', async () => {
    const onSelectModel = vi.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useAionrsModelSelection({ initialModel, onSelectModel }), { wrapper });
    await waitFor(() => expect(result.current.enterpriseCatalog?.sendBlock).toBeUndefined());
    readModels.mockResolvedValue([catalogModels[1]]);
    await act(async () => result.current.enterpriseCatalog?.refresh(false));
    expect(result.current.enterpriseCatalog?.sendBlock).toBe('invalid');
    expect(result.current.current_model?.use_model).toBe('rc2-terra');
    expect(onSelectModel).not.toHaveBeenCalled();
  });
});
