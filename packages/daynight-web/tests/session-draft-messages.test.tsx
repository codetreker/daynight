import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useDraftMessages } from '../src/features/task-agent-session/drafts/draft-messages';
import { renderWithLocale } from './helpers/renderWithLocale';
import type { Locale } from '../src/i18n/locale';

// Every reasonCode accepted by imageCapabilitySchema in
// packages/daynight-server/internal/core/session/protocol/images.go.
const capabilityReasons = ['model_unsupported', 'capability_unknown', 'provider_unsupported', 'component_unsupported', 'policy_restricted', 'worker_upgrade_required', 'profile_disabled'];
const fallback = { 'en': 'The image operation could not finish.', 'zh-CN': '无法完成图片操作。' } as const;

const Issues = ({ codes }: { readonly codes: readonly string[] }) => {
  const m = useDraftMessages();
  return <ul>{codes.map(code => <li key={code} data-testid={code}>{m.issue(code)}</li>)}</ul>;
};

it.each(['en', 'zh-CN'] as const satisfies readonly Locale[])('explains every service image capability reason in %s', locale => {
  renderWithLocale(<Issues codes={[...capabilityReasons, 'not_a_known_code']} />, { locale });
  for (const code of capabilityReasons) {
    const text = screen.getByTestId(code).textContent ?? '';
    expect(text, code).not.toContain(fallback[locale]);
    expect(text, code).not.toMatch(locale === 'en' ? /connection/i : /连接/);
  }
  expect(screen.getByTestId('not_a_known_code')).toHaveTextContent(fallback[locale]);
});

it('distinguishes a disabled image profile from other capability reasons', () => {
  renderWithLocale(<Issues codes={['profile_disabled', 'model_unsupported', 'worker_upgrade_required']} />, { locale: 'zh-CN' });
  expect(screen.getByTestId('profile_disabled')).toHaveTextContent('当前模型尚未开放图片输入。草稿已保留，可移除图片后发送文字。');
  expect(screen.getByTestId('model_unsupported')).toHaveTextContent('当前模型不支持图片输入');
  expect(screen.getByTestId('worker_upgrade_required')).toHaveTextContent('Worker 需要升级');
});
