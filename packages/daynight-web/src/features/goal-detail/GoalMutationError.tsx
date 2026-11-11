import { ApiError } from '../../api/client';
import { useI18n } from '../../i18n/LocaleProvider';

export const GoalMutationError = ({ error, action, outcomeUnknown = false }: { readonly error: ApiError; readonly action: 'create' | 'editGoal' | 'status' | 'assignedTo' | 'delete'; readonly outcomeUnknown?: boolean }) => {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN';
  const invalid = action === 'editGoal'
    ? (zh ? 'Goal 信息未通过校验，请检查名称和描述。' : 'The Goal information is invalid. Check its name and description.')
    : action === 'create' ? (zh ? 'Goal 信息未通过校验，请检查名称、描述和负责人。' : 'The Goal information is invalid. Check its name, description and assignee.')
    : action === 'assignedTo' ? (zh ? '负责人不可用或请求无效，请重新选择。' : 'The assignee is unavailable or the request is invalid. Choose again.')
      : (zh ? '请求未通过校验，请检查操作后重试。' : 'The request is invalid. Check the operation and try again.');
  const messages: Record<string, string> = {
    invalid_input: invalid,
    version_conflict: zh ? 'Goal 已更改，请核对最新状态后重试。' : 'The Goal changed. Review its latest state before trying again.',
    forbidden: zh ? '没有执行此操作的权限。' : 'You do not have permission for this action.',
    unauthenticated: zh ? '登录已过期，请重新登录。' : 'Your session expired. Sign in again.',
    not_found: zh ? 'Goal 或项目不可用。' : 'The Goal or project is unavailable.',
    task_deleted: zh ? 'Goal 已删除。' : 'The Goal was deleted.',
    invalid_transition: zh ? '当前状态不允许此操作。' : 'This action is unavailable in the current state.',
    write_outcome_unknown: zh ? '操作结果尚未确认，请核对当前状态。' : 'The operation outcome is unknown. Check the current state.',
  };
  const text = outcomeUnknown ? (zh ? '操作结果尚未确认，请核对当前状态。' : 'The operation outcome is unknown. Check the current state.')
    : error.kind === 'network' ? (zh ? '无法连接服务器，请核对操作结果。' : 'Unable to connect to the server. Check the operation outcome.')
    : error.kind === 'protocol' ? (zh ? '服务器响应无法确认，请核对操作结果。' : 'The server response could not be confirmed. Check the operation outcome.')
      : messages[error.code] ?? (zh ? '操作失败。' : 'The operation failed.');
  return <p role="alert">{text} ({error.code}){error.requestId !== null && <> · <code>{error.requestId}</code></>}</p>;
};
