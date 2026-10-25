import { useState } from "react";
import type { CurrentUser } from "../../api/auth";
import { useI18n } from "../../i18n/LocaleProvider";
import { Identity } from "./feedback";
import { TokensPanel } from "./TokensPanel";

type AccountPageProps = { readonly user: CurrentUser; readonly onSignOut: () => void; readonly onIdentityMismatch: () => void };

export const AccountPage = (props: AccountPageProps) => <AccountContent key={props.user.id} {...props} />;

const AccountContent = ({ user, onSignOut, onIdentityMismatch }: AccountPageProps) => {
  const { messages: { auth: { management: { account: m } } } } = useI18n();
  const [tab, setTab] = useState<"profile" | "tokens">("profile");
  return <>
    <div className="page-heading"><div><div className="eyebrow">{m.eyebrow}</div><h1 tabIndex={-1}>{m.title}</h1><p className="subtitle">{m.subtitle}</p></div></div>
    <div className="settings-grid"><nav className="settings-nav" aria-label={m.title}>
      <button type="button" className={tab === "profile" ? "active" : ""} aria-current={tab === "profile" ? "page" : undefined} onClick={() => setTab("profile")}>{m.profileTab}</button>
      <button type="button" className={tab === "tokens" ? "active" : ""} aria-current={tab === "tokens" ? "page" : undefined} onClick={() => setTab("tokens")}>{m.tokensTab}</button>
    </nav><div className="settings-main">
      {tab === "profile" ? <><section className="panel"><div className="panel-body"><div className="profile-info"><Identity user={user} /></div><dl className="info-list"><dt>{m.loginMethod}</dt><dd>{m.viaUniAuth}</dd><dt>{m.profileSource}</dt><dd>{m.profileSourceDescription}</dd></dl></div></section><section className="panel"><div className="panel-heading"><div><h2>{m.sessionTitle}</h2><p>{m.sessionDescription}</p></div><button className="button" type="button" onClick={onSignOut}>{m.signOut}</button></div></section></>
        : <TokensPanel user={user} onIdentityMismatch={onIdentityMismatch} />}
    </div></div>
  </>;
};
