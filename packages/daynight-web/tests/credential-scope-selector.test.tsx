import { useState } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ScopeCatalog } from '../src/api/credential-scope';
import { CredentialScopeSelector, hasCredentialScopeLabels } from '../src/features/auth/CredentialScopeSelector';
import { createLocaleRender } from './helpers/renderWithLocale';

const catalog: ScopeCatalog = { catalogRevision: 'a'.repeat(64), groups: [
  { id: 'team', scopeIds: ['team:read', 'team:write', 'team:invitation-accept'] },
  { id: 'worker-execution', scopeIds: ['worker:complete'] },
], defaultScopes: ['team:read'] };
const Harness = ({ value = catalog, disabled = false, onChange = () => {} }: { value?: ScopeCatalog; disabled?: boolean; onChange?: (scopes: string[]) => void }) => {
  const [selected, setSelected] = useState<readonly string[]>(catalog.defaultScopes);
  return <CredentialScopeSelector catalog={value} selected={selected} disabled={disabled} onChange={scopes => { setSelected(scopes); onChange(scopes); }} />;
};

describe('credential scope selector', () => {
  it('starts collapsed with counts and selects only actual group IDs', () => {
    const changed = vi.fn(); const view = createLocaleRender('en')(<Harness onChange={changed} />);
    const summaries = screen.getAllByText(/\/ [13]/); expect(summaries.map(item => item.textContent)).toEqual(['1 / 3', '0 / 1']);
    const team = screen.getByText('Teams').closest('details')!; const worker = screen.getByText('Worker execution').closest('details')!;
    expect(team).not.toHaveAttribute('open'); expect(worker).not.toHaveAttribute('open');
    fireEvent.click(within(team).getByText('Teams'));
    const all = within(team).getByRole('checkbox', { name: 'Select this group · Teams' });
    expect(all).toBePartiallyChecked();
    fireEvent.click(all); expect(changed).toHaveBeenLastCalledWith(['team:read', 'team:write', 'team:invitation-accept']);
    expect(all).toBeChecked(); expect(screen.getByText('Selected 3')).toBeInTheDocument();
    fireEvent.click(all); expect(changed).toHaveBeenLastCalledWith([]); expect(screen.getByText('Selected 0')).toBeInTheDocument();
    fireEvent.click(within(worker).getByText('Worker execution')); fireEvent.click(within(worker).getByRole('checkbox', { name: /Complete claimed tasks/ }));
    expect(changed).toHaveBeenLastCalledWith(['worker:complete']);
    view.setLocale('zh-CN'); expect(screen.getByText('已选 1')).toBeInTheDocument(); expect(within(worker).getByRole('checkbox', { name: /完成已领取的任务/ })).toBeChecked();
  });
  it('preserves valid and unavailable choices across catalog changes and edits', () => {
    const changed = vi.fn(); const view = createLocaleRender('en')(<Harness onChange={changed} />);
    fireEvent.click(screen.getByText('Teams')); fireEvent.click(screen.getByRole('checkbox', { name: /Create and rename Teams/ }));
    const updated: ScopeCatalog = { ...catalog, catalogRevision: 'b'.repeat(64), groups: [{ id: 'team', scopeIds: ['team:read', 'team:invitation-accept'] }] };
    view.rerender(<Harness value={updated} onChange={changed} />);
    expect(screen.getByRole('checkbox', { name: /View Teams/ })).toBeChecked(); expect(screen.getByText('Selected 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Accept received Team invitations/ }));
    expect(changed).toHaveBeenLastCalledWith(['team:read', 'team:invitation-accept', 'team:write']);
  });
  it('exposes unknown IDs and detects missing labels while disabled controls cannot change the draft', () => {
    const unknown: ScopeCatalog = { ...catalog, groups: [{ id: 'future', scopeIds: ['future:write'] }] };
    expect(hasCredentialScopeLabels(catalog, 'en')).toBe(true); expect(hasCredentialScopeLabels(catalog, 'zh-CN')).toBe(true);
    expect(hasCredentialScopeLabels(unknown, 'en')).toBe(false);
    expect(hasCredentialScopeLabels({ ...catalog, groups: [{ id: 'team', scopeIds: ['team:future'] }] }, 'zh-CN')).toBe(false);
    const changed = vi.fn(); createLocaleRender('en')(<Harness value={unknown} disabled onChange={changed} />);
    fireEvent.click(screen.getAllByText('future')[0]!); expect(screen.getByRole('checkbox', { name: /future:write/ })).toBeDisabled(); expect(changed).not.toHaveBeenCalled();
  });
});
