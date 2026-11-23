import type { ReactNode } from "react";

type SidebarIconName = "projects" | "settings" | "tasks" | "githubApps" | "shared" | "workers" | "bots" | "webhooks" | "sessions";

const shapes: Record<SidebarIconName, ReactNode> = {
  projects: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  settings: <><polygon points="12,4.8 13.756,3.173 15.444,3.685 16,6.013 17.091,6.909 19.483,7 20.315,8.556 19.062,10.595 19.2,12 20.827,13.756 20.315,15.444 17.987,16 17.091,17.091 17,19.483 15.444,20.315 13.405,19.062 12,19.2 10.244,20.827 8.556,20.315 8,17.987 6.909,17.091 4.517,17 3.685,15.444 4.938,13.405 4.8,12 3.173,10.244 3.685,8.556 6.013,8 6.909,6.909 7,4.517 8.556,3.685 10.595,4.938" /><circle cx="12" cy="12" r="3" /></>,
  tasks: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  githubApps: <path d="M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z" />,
  shared: <path d="m12 3 9 9-9 9-9-9Z" />,
  workers: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 8h10M7 12h6" /></>,
  bots: <><rect x="4" y="7" width="16" height="13" rx="3" /><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" /></>,
  webhooks: <path d="M10.11892 10.44303a3.61713 3.61713 0 1 1 4.52141 -5.42569M19.16174 10.44303a3.61713 3.61713 0 1 1 -3.61713 6.32997M10.11892 17.67729a3.61713 3.61713 0 1 1 -3.61713 -4.52141M10.11892 10.44303l-2.71285 5.42569h10.85138M14.64033 6.8259l4.52141 7.23426" />,
  sessions: <path d="M6 3 21 12 6 21Z" />,
};

export const SidebarIcon = ({ name }: { readonly name: SidebarIconName }) => <span className="nav-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">{shapes[name]}</svg></span>;
