import type { ScopeCatalog } from '../../api/credential-scope';
import { useI18n } from '../../i18n/LocaleProvider';
import { CredentialScopeSelector, credentialScopeLabel } from '../auth/CredentialScopeSelector';

/** Retain unavailable saved scopes until the user explicitly removes them. */
export const CredentialScopeEditor = ({ catalog, original, selected, onChange, disabled = false }: {
  readonly catalog: ScopeCatalog;
  readonly original: readonly string[];
  readonly selected: readonly string[];
  readonly onChange: (scopes: string[]) => void;
  readonly disabled?: boolean;
}) => {
  const { locale } = useI18n();
  const available = new Set(catalog.groups.flatMap(group => group.scopeIds));
  const unavailable = selected.filter(id => !available.has(id));
  const added = selected.filter(id => !original.includes(id));
  const removed = original.filter(id => !selected.includes(id));
  return <>
    <CredentialScopeSelector catalog={catalog} selected={selected} onChange={onChange} disabled={disabled} />
    {unavailable.length > 0 && <div className="notice warning" role="status">
      <p>{locale === 'zh-CN' ? '当前不可用的权限：' : 'Permissions currently unavailable:'}</p>
      <ul>{unavailable.map(id => <li key={id}>{credentialScopeLabel(id, locale) && <>{credentialScopeLabel(id, locale)} </>}<code>{id}</code></li>)}</ul>
      <button className="button" type="button" disabled={disabled} onClick={() => onChange(selected.filter(id => available.has(id)))}>{locale === 'zh-CN' ? '移除不可用权限' : 'Remove unavailable permissions'}</button>
    </div>}
    <section aria-label={locale === 'zh-CN' ? '权限变更' : 'Permission changes'}>
      <p><strong>{locale === 'zh-CN' ? '新增' : 'Added'}</strong>: {added.length === 0 ? (locale === 'zh-CN' ? '无' : 'None') : added.map((id, index) => <span key={id}>{index > 0 && ', '}{credentialScopeLabel(id, locale) && <>{credentialScopeLabel(id, locale)} </>}<code>{id}</code></span>)}</p>
      <p><strong>{locale === 'zh-CN' ? '移除' : 'Removed'}</strong>: {removed.length === 0 ? (locale === 'zh-CN' ? '无' : 'None') : removed.map((id, index) => <span key={id}>{index > 0 && ', '}{credentialScopeLabel(id, locale) && <>{credentialScopeLabel(id, locale)} </>}<code>{id}</code></span>)}</p>
    </section>
  </>;
};
