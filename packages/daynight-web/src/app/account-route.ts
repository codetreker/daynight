export type AccountTab = 'profile' | 'tokens' | 'prompt';
export type AccountSelection =
  | { readonly kind: 'tab'; readonly tab: AccountTab }
  | { readonly kind: 'invalid' };

export const accountSelection = (search: string): AccountSelection => {
  const values = new URLSearchParams(search).getAll('tab');
  if (values.length === 0) return { kind: 'tab', tab: 'profile' };
  const tab = values[0];
  return values.length === 1 && (tab === 'profile' || tab === 'tokens' || tab === 'prompt')
    ? { kind: 'tab', tab }
    : { kind: 'invalid' };
};

export const accountUrl = (tab: AccountTab): string => tab === 'profile' ? '/account' : `/account?tab=${tab}`;
