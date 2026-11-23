export type ImpactProjectPage = {
  readonly items: readonly { readonly id: string; readonly name: string; readonly repoUrl: string }[];
  readonly hiddenProjects: string;
  readonly nextCursor: string | null;
};

// Presentation is deliberately stateless: only the owner may admit or clear a page.
export const ImpactProjects = ({ hiddenProjects, page, blocked, labels, onRead, onMore }: {
  readonly hiddenProjects: string;
  readonly page: ImpactProjectPage | null;
  readonly blocked: boolean;
  readonly labels: { readonly hidden: string; readonly visible: string; readonly projects: string; readonly more: string };
  readonly onRead: () => void;
  readonly onMore: () => void;
}) => <>
  <p>{page?.hiddenProjects ?? hiddenProjects} {labels.hidden}</p>
  <h3>{labels.visible}</h3>
  {page ? <><ul>{page.items.map(project => <li key={project.id}>{project.name} · {project.repoUrl}</li>)}</ul>{page.nextCursor && <button className="button" type="button" aria-disabled={blocked} onClick={() => { if (!blocked) onMore(); }}>{labels.more}</button>}</> : <button className="button" type="button" aria-disabled={blocked} onClick={() => { if (!blocked) onRead(); }}>{labels.projects}</button>}
</>;
