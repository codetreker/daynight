import type { PauseMessages } from '../pause';

export const pause: PauseMessages = {
  label: 'Paused', count: (count) => `${count} paused`, openTask: (title) => `Open paused task: ${title}`, listTitle: 'Paused tasks', truncated: 'Title truncated',
  unpause: 'Unpause', unpausing: 'Unpausing…', unavailable: 'Task changes are unavailable until the current task details and access can be confirmed.',
  confirmed: 'The task is unpaused.',
  conflict: 'The task changed. Check its current pause state before trying again.',
  unknown: 'The unpause result is not confirmed. Check the current task state before making another change.',
  reconciled: 'The current task state has been read. This does not establish the outcome of the earlier unpause request.',
  checking: 'Checking the current task state…', checkState: 'Check task state', checkFailed: 'The current task state could not be read. Task changes remain unavailable until it can be read.',
  networkError: 'The unpause request did not receive a confirmed response from the service.',
  protocolError: 'The service response could not confirm the unpause request result.',
  versionConflict: 'The task version changed before the unpause request could be applied.',
  notFound: 'The task or project is no longer available.', refused: 'The service refused the unpause request.', requestFailed: 'The unpause request failed.',
};
