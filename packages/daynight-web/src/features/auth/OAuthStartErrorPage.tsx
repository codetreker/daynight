import { useLayoutEffect } from 'react';
import { useI18n } from '../../i18n/LocaleProvider';
import { LanguageSelector } from '../../i18n/LanguageSelector';

const copy = {
  'zh-CN': { eyebrow: '连接到 DAYNIGHT', title: '无法授权此客户端', detail: '客户端或返回地址不符合此授权请求，无法继续。请返回客户端重新连接。', noDelivery: '未向此返回地址发送授权信息。' },
  en: { eyebrow: 'CONNECT TO DAYNIGHT', title: 'Cannot authorize this client', detail: 'The client or return address does not match this authorization request. Return to the client to reconnect.', noDelivery: 'No authorization information was sent to this return address.' },
} as const;

export const OAuthStartErrorPage = () => {
  const { locale } = useI18n();
  const m = copy[locale];
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = `${m.title} · Daynight`;
    // The failed request's state and client parameters are not needed by this page.
    if (window.location.search !== '' || window.location.hash !== '') window.history.replaceState(window.history.state, '', window.location.pathname);
  }, [locale, m.title]);
  return <div className="invite-page device-page"><div className="brand" aria-label="Daynight"><span className="brand-mark" aria-hidden="true" />daynight</div><main className="invite-card device-card consent-card" aria-labelledby="oauth-error-title"><LanguageSelector /><p className="eyebrow">{m.eyebrow}</p><h1 id="oauth-error-title">{m.title}</h1><div className="device-result" role="alert"><div className="device-result-mark" aria-hidden="true">×</div><p>{m.detail}</p><p className="result-detail">{m.noDelivery}</p></div></main></div>;
};
