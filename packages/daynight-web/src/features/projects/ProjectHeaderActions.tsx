export function ProjectSettingsActionContent({ label }: { readonly label: string }) {
  return <><svg className="project-header-action-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3h4l1 3 3 1 3 2-1 3 1 3-3 2-3 1-1 3h-4l-1-3-3-1-3-2 1-3-1-3 3-2 3-1z"/><circle cx="12" cy="12" r="3"/></svg><span className="project-header-action-label">{label}</span><span className="project-header-action-tooltip" aria-hidden="true">{label}</span></>;
}
