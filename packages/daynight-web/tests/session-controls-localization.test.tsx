import { readFileSync } from 'node:fs';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot, SessionOperation } from '../src/api/types';
import type { SessionControls, SessionSetting, SessionNativeCommand } from '../../daynight/src/session/controls';
import { SessionComposer } from '../src/features/task-agent-session/SessionComposer';
import { SessionControlsPanel } from '../src/features/task-agent-session/SessionControlsPanel';
import { emptySessionState, hydrateSession } from '../src/features/task-agent-session/state';
import { renderWithLocale } from './helpers/renderWithLocale';

type Provider = 'codex' | 'claude' | 'copilot';
const setting = (id: string, label: string, options: readonly (readonly [string, string])[], description: string | null = 'Controller explanation'): SessionSetting => ({
  id, label, category: id === 'model' ? 'model' : id === 'effort' ? 'reasoning' : 'permission', description,
  value: options[0]?.[0] ?? null, options: options.map(([value, label]) => ({ value, label })), mutable: true, scope: 'session',
});
const model = setting('model', 'Model', [['native-model', 'Native Model']]);
const effort = setting('effort', 'Reasoning effort', [['low', 'low'], ['medium', 'medium'], ['future-level', 'Future level']]);
const catalogs: Record<Provider, readonly SessionSetting[]> = {
  codex: [model, effort,
    setting('approval', 'Approval policy', [['untrusted', 'Untrusted'], ['on-request', 'On request'], ['never', 'Never ask'], ['future-policy', 'Future policy']]),
    setting('sandbox', 'Sandbox', [['readOnly', 'Read only'], ['workspaceWrite', 'Workspace write'], ['dangerFullAccess', 'Full access']]),
  ],
  claude: [model, { ...effort, options: [...effort.options, { value: 'default', label: 'Native default' }] },
    setting('permissions', 'Permissions', [['default', 'Ask for permissions'], ['acceptEdits', 'Accept edits'], ['dontAsk', 'Deny unapproved tools'], ['plan', 'Plan'], ['bypassPermissions', 'Full access (YOLO)']]),
  ],
  copilot: [model, effort, setting('tool_approval', 'Tool approvals', [['ask', 'Ask for approval'], ['allow', 'Allow tools']])],
};
function state(provider: Provider, settings = catalogs[provider], commands: readonly SessionNativeCommand[] = []) {
  const fixture = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')) as SessionSnapshot;
  const controls: SessionControls = { revision: '7', settings, commands, settingsError: null, commandsError: null };
  return hydrateSession(emptySessionState(), { ...fixture, identity: { ...fixture.identity, provider }, controls, turnStartedAt: null }, []);
}
const command = (id: string, name: string, description: string, argumentHint: string | null = null): SessionNativeCommand => ({ id, name, description, argumentHint, available: true });
const composerProps = (provider: Provider, commands: readonly SessionNativeCommand[] = []) => ({ state: state(provider, undefined, commands), connected: true,
  onSend: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onExecuteCommand: vi.fn(async () => {}), onUpdateSetting: vi.fn(async () => {}), onRefreshControls: vi.fn(async () => {}) });

describe('localized provider settings', () => {
  it.each([
    ['codex', ['审批策略', '沙箱'], ['仅信任的命令免审批', '按需请求审批', '从不请求审批', 'Future policy', '只读', '工作区写入', '完全访问'], '后续轮次的审批策略。沙箱限制独立生效。'],
    ['claude', ['权限'], ['请求权限', '允许编辑', '拒绝未经批准的工具', '计划', '完全访问（YOLO）'], '原生权限模式。完全访问无需询问即可运行工具，并禁用沙箱。'],
    ['copilot', ['工具审批'], ['请求审批', '允许工具'], '原生工具审批策略。已有授权、路径权限和网络权限独立生效。'],
  ] as const)('translates %s permission labels and keeps option values unchanged', async (provider, labels, options, description) => {
    const props = composerProps(provider);
    const view = renderWithLocale(<SessionComposer {...props} />, { locale: 'zh-CN' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '保留草稿' } });
    const trigger = screen.getByRole('button', { name: 'Permissions' });
    fireEvent.click(trigger);
    for (const label of labels) expect(screen.getByRole('combobox', { name: label })).toBeVisible();
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(options);
    expect(screen.getByText(description)).toBeVisible();
    const first = screen.getAllByRole('combobox')[0]!;
    const original = catalogs[provider].find(item => item.category === 'permission')!;
    fireEvent.change(first, { target: { value: original.options[1]!.value } });
    await waitFor(() => expect(props.onUpdateSetting).toHaveBeenCalledWith(original.id, original.options[1]!.value, '7'));
    view.setLocale('en');
    expect(screen.getByRole('combobox', { name: original.label })).toBe(first);
    expect(screen.getByRole('textbox')).toHaveValue('保留草稿');
    expect(screen.getByRole('button', { name: 'Permissions' })).toBe(trigger);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it.each([
    ['codex', '在支持时更改后续原生步骤，并应用于后续轮次。', '原生模型定义支持的推理强度。'],
    ['claude', '应用于后续原生请求。默认模型由 Claude Code 决定。', '应用于后续原生请求。原生默认会清除推理强度覆盖。'],
    ['copilot', '原生模型切换可能排队等待当前轮次结束。', '未指定推理强度时使用原生默认值。更改应用于后续轮次。'],
  ] as const)('uses %s descriptions without translating native model or effort labels', (provider, modelDescription, effortDescription) => {
    const props = composerProps(provider);
    const view = renderWithLocale(<SessionComposer {...props} />, { locale: 'zh-CN' });
    fireEvent.click(screen.getByRole('button', { name: '模型' }));
    expect(screen.getByRole('combobox', { name: '模型' })).toHaveValue('native-model');
    const effortSelect = screen.getByRole('combobox', { name: '推理强度' });
    expect(effortSelect).toHaveValue('low');
    expect(within(effortSelect).getAllByRole('option').map(option => option.textContent)).toEqual(provider === 'claude' ? ['low', 'medium', 'Future level', '原生默认'] : ['low', 'medium', 'Future level']);
    expect(screen.getByText(modelDescription)).toBeVisible();
    expect(screen.getByText(effortDescription)).toBeVisible();
    view.setLocale('en');
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBe(effortSelect);
    expect(screen.getByRole('option', { name: 'Native Model' })).toBeVisible();
    if (provider === 'claude') expect(screen.getByRole('option', { name: 'Native default' })).toHaveValue('default');
  });

  it('updates pending and confirmed labels in place without submitting or dropping intent', () => {
    const props = composerProps('codex'), s = props.state;
    const operation = { protocol: s.snapshot!.protocol, sessionId: s.snapshot!.sessionId, claimId: s.snapshot!.claimId, executionGeneration: '1', operationId: 'pending', kind: 'update_setting', state: 'unknown', providerResult: null, error: null } as SessionOperation;
    const intents = new Map([['approval', { operationId: 'pending', settingId: 'approval', value: 'never', confirmedValue: 'untrusted' }]]);
    const view = renderWithLocale(<SessionComposer {...props} state={{ ...s, operations: new Map([['pending', operation]]) }} settingIntents={intents} />, { locale: 'en' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Permissions' }));
    const select = screen.getByRole('combobox', { name: 'Approval policy' });
    expect(select).toHaveValue('never');
    expect(screen.getByText(/Current: Untrusted/)).toBeVisible();
    view.setLocale('zh-CN');
    expect(screen.getByRole('combobox', { name: '审批策略' })).toBe(select);
    expect(select).toHaveValue('never');
    expect(screen.getByText(/更改结果未知.*当前: 仅信任的命令免审批/)).toBeVisible();
    expect(screen.getByRole('textbox')).toHaveValue('draft');
    expect(props.onUpdateSetting).not.toHaveBeenCalled();
  });

  it('preserves unknown settings, foreign-provider IDs, missing descriptions and unlisted current values', () => {
    const settings = [setting('__proto__', 'Future setting', [['future', 'Future option']], 'Future description'),
      setting('permissions', 'Foreign permissions', [['default', 'Foreign default']], 'Foreign description'),
      { ...setting('approval', 'Approval policy', [['never', 'Never ask']], null), value: 'future-current' }];
    const s = state('codex', settings);
    renderWithLocale(<SessionControlsPanel controls={s.snapshot!.controls} state={s} intents={new Map()} view="permissions" disabled={false} onClose={() => {}} onSelect={undefined} onRefresh={undefined} />, { locale: 'zh-CN' });
    expect(screen.getByRole('combobox', { name: 'Future setting' })).toHaveValue('future');
    expect(screen.getByRole('option', { name: 'Future option' })).toBeVisible();
    expect(screen.getByText('Future description')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Foreign permissions' })).toHaveValue('default');
    expect(screen.getByText('Foreign description')).toBeVisible();
    expect(screen.getByRole('option', { name: 'Foreign default' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: '审批策略' })).toHaveValue('future-current');
    expect(screen.getByRole('option', { name: 'future-current' })).toBeVisible();
    expect(screen.queryByText('后续轮次的审批策略。沙箱限制独立生效。')).toBeNull();
  });
});

describe('localized built-in command descriptions', () => {
  it.each([
    ['codex', [command('compact', 'compact', 'Compact the current Codex thread'), command('prompt:review', 'prompts:review', 'Custom Codex prompt'), command('skill:review', 'review', 'Codex skill', 'Instructions for this skill')], ['压缩当前 Codex 会话', '自定义 Codex 提示词', 'Codex 技能']],
    ['claude', [command('claude:review', 'review', 'Claude command')], ['Claude 命令']],
    ['copilot', [command('review', 'review', 'Copilot skill')], ['Copilot 技能']],
  ] as const)('localizes %s built-ins while retaining unknown command content', (provider, commands, descriptions) => {
    const originals = [...commands, command('unknown', 'future', 'Compact the current Codex thread'), command('skill:custom', 'custom', 'Provider-authored description', 'Native argument hint')];
    const props = composerProps(provider, originals);
    const view = renderWithLocale(<SessionComposer {...props} />, { locale: 'zh-CN' });
    fireEvent.click(screen.getByRole('button', { name: '打开会话命令' }));
    for (const description of descriptions) expect(screen.getByText(description)).toBeVisible();
    expect(screen.getByText('Compact the current Codex thread')).toBeVisible();
    expect(screen.getByText('Provider-authored description')).toBeVisible();
    expect(screen.queryByText('Native argument hint')).toBeNull();
    fireEvent.pointerMove(screen.getByRole('option', { name: /Provider-authored description/ }), { pointerType: 'mouse', clientX: 20, clientY: 40 });
    expect(screen.getByText('Native argument hint')).toBeVisible();
    if (provider === 'codex') {
      fireEvent.pointerMove(screen.getByRole('option', { name: /Codex 技能/ }), { pointerType: 'mouse', clientX: 20, clientY: 80 });
      expect(screen.getByText('Instructions for this skill')).toBeVisible();
      expect(screen.queryByText('Native argument hint')).toBeNull();
    }
    view.setLocale('en');
    for (const item of commands) expect(screen.getByRole('option', { name: new RegExp(`^/${item.name}`) })).toHaveTextContent(item.description);
    expect(props.state.snapshot!.controls!.commands).toEqual(originals);
  });

  it('preserves explicit command selection across a language change and executes the original ID', async () => {
    const props = composerProps('codex', [command('skill:review', 'review', 'Codex skill', 'Instructions for this skill')]);
    const view = renderWithLocale(<SessionComposer {...props} />, { locale: 'en' });
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/rev' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    view.setLocale('zh-CN');
    expect(screen.getByRole('option', { selected: true })).toHaveTextContent('Codex 技能');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('/review ');
    fireEvent.change(input, { target: { value: '/review 原生参数' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(props.onExecuteCommand).toHaveBeenCalledWith('skill:review', '原生参数', '7', '/review 原生参数'));
    expect(props.onSend).not.toHaveBeenCalled();
  });
});
