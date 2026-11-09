import { ApiError } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';
import type { WorkspaceMessages } from '../../i18n/messages/workspace';
import { GraphDataError } from '../task-graph/model';

export const projectGraphErrorTitle = (error: unknown, m: WorkspaceMessages["project"]): string => {
  if (error instanceof ApiError && error.code === "not_found") return m.notFound;
  if (error instanceof GraphDataError || error instanceof ApiError && error.kind === "protocol") return m.incomplete;
  return m.loadingFailed;
};

export const ProjectGraphErrorDetail = ({ error }: { readonly error: unknown }) => {
  const { messages: { workspace: { project: m }, common } } = useI18n();
  return <>
    <p>{error instanceof ApiError && error.kind === "network"
      ? m.networkError
      : error instanceof GraphDataError || error instanceof ApiError && error.kind === "protocol"
        ? m.protocolError
        : error instanceof ApiError && error.code === "not_found"
          ? m.notFoundDetail
          : m.readError}</p>
    {error instanceof ApiError && error.requestId !== null && (
      <p className="request-id">{common.requestId}<code>{error.requestId}</code></p>
    )}
  </>;
};
