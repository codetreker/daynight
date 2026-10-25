import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DeviceAuthorizationPage, type DeviceAuthorizationApi } from "../../src/features/auth/DeviceAuthorizationPage";
import { ApiError } from "../../src/api/client";
import { LocaleProvider, useI18n } from "../../src/i18n/LocaleProvider";
import { resolveInitialLocale } from "../../src/i18n/locale";
import "../../src/styles/app.css";
import "../../src/styles/auth.css";

const scenarios = [
  ["pending", "核对并授权"], ["manual", "手工输入授权码"], ["loading", "读取中"], ["approved", "已经授权"], ["denied", "已经拒绝"],
  ["expired", "授权码过期"], ["unavailable", "无效或不可见的授权码"], ["network", "网络错误"], ["limited", "尝试次数过多"],
  ["uncertain-approved", "授权成功但响应丢失"], ["uncertain-pending", "提交失败，核对后仍待确认"], ["uncertain-readback", "提交结果未知且核对失败"], ["long-account", "长账户名称与邮箱"],
] as const;
type Scenario = typeof scenarios[number][0];
const code = "BCDFG-HJKLM";
const user = { id: "00000000-0000-4000-8000-000000000001", name: "Alice Chen", email: "alice@example.com", emailVerified: true, avatarUrl: null };
const wait = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 450);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
});

const DeviceMockup = () => {
  const { locale, messages } = useI18n();
  useEffect(() => { document.documentElement.lang = locale; document.title = messages.auth.shell.documentTitle.device; }, [locale, messages]);
  const requested = new URLSearchParams(window.location.search).get("scenario");
  const [scenario, setScenario] = useState<Scenario>(scenarios.some(([id]) => id === requested) ? requested as Scenario : "pending");
  const [revision, setRevision] = useState(0);
  const decision = useRef<"approve" | "deny" | null>(null);
  const [notice, setNotice] = useState("");
  const transport = useMemo<DeviceAuthorizationApi>(() => ({
    inspect: async (userCode, _userId, signal) => {
      if (scenario === "loading") return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      await wait(signal);
      if (scenario === "uncertain-readback" && decision.current !== null) throw new ApiError("network");
      if (scenario === "network") throw new ApiError("network");
      if (scenario === "unavailable") throw new ApiError("server", 404, "not_found", "device-fixture-not-found");
      if (scenario === "limited") throw new ApiError("server", 429, "rate_limited", "device-fixture-rate");
      return { userCode, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), status: scenario === "expired" || scenario === "approved" || scenario === "denied" ? scenario : scenario === "uncertain-approved" && decision.current !== null ? "approved" : "pending" };
    },
    decide: async (_userCode, choice, _userId, signal) => {
      await wait(signal); decision.current = choice;
      if (scenario.startsWith("uncertain")) throw new ApiError("network");
    },
  }), [scenario, revision]);
  const reset = (next: Scenario) => { decision.current = null; setNotice(""); setScenario(next); setRevision((value) => value + 1); };
  return <><DeviceAuthorizationPage key={revision} user={scenario === "long-account" ? { ...user, name: "Alice Chen · Platform Infrastructure and Developer Experience", email: "alice.developer-experience-and-platform-infrastructure@example.com" } : user} initialCode={scenario === "manual" ? null : code} transport={transport} onSwitchAccount={() => setNotice("正式页面会退出当前账户，再使用现有 UniAuth 登录并返回此请求。")} onIdentityMismatch={() => setNotice("当前账户已改变，请重新确认身份。")} />
    <aside style={{ position: "fixed", zIndex: 100, bottom: 12, left: 12, maxWidth: "calc(100vw - 24px)", background: "#fffffff5", border: "1px solid #e2e4ed", borderRadius: 8, fontSize: 11, boxShadow: "0 4px 22px #25325312" }} aria-label="Device authorization fixture controls"><details><summary style={{ padding: "8px 12px", cursor: "pointer" }}>设备授权 · 交互场景</summary><div style={{ display: "grid", gap: 9, padding: "4px 12px 12px", width: 310, maxWidth: "calc(100vw - 28px)" }}><label htmlFor="device-scenario">场景</label><select id="device-scenario" value={scenario} onChange={(event) => reset(event.currentTarget.value as Scenario)}>{scenarios.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><button className="button" onClick={() => reset(scenario)} type="button">重置当前场景</button><p>与正式页面共用组件、样式和双语文案。所有结果仅保存在此页面，无需后端。</p><p>终端授权码：{code}</p>{notice !== "" && <p role="status">{notice}</p>}</div></details></aside>
  </>;
};
const container = document.getElementById("root");
if (container === null) throw new Error("The device authorization fixture root is required.");
const root = createRoot(container);
root.render(<LocaleProvider initial={resolveInitialLocale()}><DeviceMockup /></LocaleProvider>);
import.meta.hot?.dispose(() => root.unmount());
