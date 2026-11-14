import { ApiError } from '../api/client';
import { canonicalId } from '../api/parse';

export type ProjectSettingsTab = 'execution' | 'prompts' | 'github' | 'members' | 'management';
export type ProjectSettingsSelection =
  | { readonly kind: 'tab'; readonly tab: ProjectSettingsTab }
  | { readonly kind: 'invalid' };

export const projectSettingsSelection = (search: string): ProjectSettingsSelection => {
  const values = new URLSearchParams(search).getAll('tab');
  if (values.length === 0) return { kind: 'tab', tab: 'execution' };
  const tab = values[0];
  return values.length === 1 && (tab === 'execution' || tab === 'prompts' || tab === 'github' || tab === 'members' || tab === 'management')
    ? { kind: 'tab', tab }
    : { kind: 'invalid' };
};

export const projectSettingsUrl = (projectId: string, tab: ProjectSettingsTab): string => {
  if (canonicalId(projectId) === null || !['execution', 'prompts', 'github', 'members', 'management'].includes(tab)) throw new ApiError('protocol');
  const base = `/projects/${encodeURIComponent(projectId)}/settings`;
  return tab === 'execution' ? base : `${base}?tab=${tab}`;
};
