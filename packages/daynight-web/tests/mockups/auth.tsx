import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Application } from '../../src/app/Application';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { resolveInitialLocale } from '../../src/i18n/locale';
import { authScenarios, installAuthFixture, readAuthScenario, type AuthScenario } from './auth-fixture';
import '../../src/styles/app.css';

const initial = readAuthScenario();
const fixtureDocument = window.location.pathname;
const initialLocale = resolveInitialLocale();
document.documentElement.lang = initialLocale.locale;
export const authFixture = installAuthFixture(initial);
const fixture = authFixture;
const AuthMockup = () => {
  const [scenario, setScenario] = useState<AuthScenario>(initial);
  const [revision, setRevision] = useState(0);
  const [identityControl, setIdentityControl] = useState('暂停检查后，切换到另一个浏览器标签页，再切回这里。等待期间可以继续编辑当前页面。');
  const reset = (next: AuthScenario) => { fixture.reset(next); setScenario(next); setRevision((value) => value + 1); setIdentityControl('暂停检查后，切换到另一个浏览器标签页，再切回这里。等待期间可以继续编辑当前页面。'); };
  return <>
    <Application key={revision} navigateToLogin={(url) => { fixture.completeLogin(url); setRevision((value) => value + 1); }} />
    <aside aria-label="Authentication fixture controls" ref={(node) => { if (node !== null) Object.defineProperty(node, 'authFixture', { configurable: true, value: fixture }); }} style={{ position: 'fixed', zIndex: 200, bottom: 12, left: 12, maxWidth: 'calc(100vw - 24px)', border: '1px solid #e2e4ed', borderRadius: 8, background: '#fffffff5', boxShadow: '0 4px 22px #25325312', fontSize: 11 }}>
      <details><summary style={{ padding: '8px 12px', cursor: 'pointer', color: '#746c5d' }}>Component fixture · 场景</summary><div style={{ padding: '4px 12px 12px', width: 340, maxWidth: 'calc(100vw - 26px)', display: 'grid', gap: 10 }}>
        <label htmlFor="auth-fixture-scenario">受控 API 场景</label><select id="auth-fixture-scenario" value={scenario} onChange={(event) => reset(event.currentTarget.value as AuthScenario)}>{authScenarios.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
        <button className="button" type="button" onClick={() => reset(scenario)}>重置当前场景</button>
        <p>真实组件与受控同源 API；更改只保存在页面内。登录按钮模拟身份交接，不能证明 UniAuth 接入。</p>
        {(scenario.startsWith('tokens') || scenario.startsWith('token-') || scenario === 'clipboard-failure') && <p>选择「访问令牌」后创建令牌，检查一次性显示、复制或复制失败后的手工恢复。</p>}
        {scenario === 'attachments' && <p>原生 iframe 资源由浏览器验证按正常 API 路径提供；此 fixture 不替换产品附件 URL。</p>}
        <fieldset style={{ border: '1px solid #e2e4ed', borderRadius: 6, display: 'grid', gap: 8 }}>
          <legend>前台返回 · 身份检查</legend>
          <button className="button" type="button" onClick={() => { fixture.pauseIdentityChecks(); setIdentityControl('检查已暂停。切到另一个标签页再返回，检查会保持等待，页面仍可操作。'); }}>暂停下一次身份检查</button>
          <button className="button" type="button" onClick={() => { fixture.resumeIdentityChecks(); setIdentityControl('已返回同一账户。当前界面、焦点与未提交内容保持。'); }}>返回同一账户</button>
          <button className="button" type="button" onClick={() => { fixture.switchToAlice(); fixture.resumeIdentityChecks(); setIdentityControl('已返回 Alice Chen，旧账户界面会在身份确认后清除。'); }}>返回另一个账户</button>
          <button className="button" type="button" onClick={() => { fixture.failIdentityChecks(); setIdentityControl('身份检查返回 503。错误界面提供重试；重试后确认当前账户。'); }}>返回检查失败</button>
          <button className="button" type="button" onClick={() => { fixture.expireIdentityChecks(); setIdentityControl('身份检查返回 401，当前会话结束。'); }}>返回登录失效</button>
          <p role="status">{identityControl}</p>
        </fieldset>
        <a className="button" href={`${fixtureDocument}?scenario=${scenario}`}>重新载入 fixture 文档</a>
      </div></details>
    </aside>
  </>;
};

const container = document.getElementById('root');
if (container === null) throw new Error('The authentication fixture root is required.');
const root = createRoot(container);
root.render(<LocaleProvider initial={initialLocale}><AuthMockup /></LocaleProvider>);
import.meta.hot?.dispose(() => { root.unmount(); fixture.dispose(); });
