import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import "./account-change-banner.css";

type AccountChangeBannerProps = {
  /** True only when this header is the active presentation of the notice. */
  readonly active: boolean;
  readonly onReload: () => void;
};

export const AccountChangeBanner = ({ active, onReload }: AccountChangeBannerProps) => {
  const { messages: { auth: { accountChange } } } = useI18n();
  const [announcing, setAnnouncing] = useState(false);
  useEffect(() => { setAnnouncing(active); }, [active]);
  const visible = active && announcing;
  return <div className={visible ? "account-change-banner" : "account-change-banner-empty"} role="status" aria-live="polite" aria-atomic="true">
    {visible && <><span>{accountChange.message}</span>
      <button type="button" onClick={onReload}>{accountChange.reload}</button></>}
  </div>;
};
