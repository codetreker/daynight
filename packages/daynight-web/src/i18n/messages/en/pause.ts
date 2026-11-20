import type { PauseMessages } from '../pause';

export const pause: PauseMessages = {
  label: 'Blocked', count: (count) => `${count} blocked`, listTitle: 'Blocked tasks', truncated: 'Title truncated',
  unpause: 'Unblock', unpausing: 'Unblocking…', unavailable: 'Task changes are unavailable until the current task details and access can be confirmed.',
  confirmed: 'The task is unblocked.',
  conflict: 'The task changed. Check its current blocked state before trying again.',
  unknown: 'The unblock result is not confirmed. Check the current task state before making another change.',
  reconciled: 'The current task state has been read. This does not establish the outcome of the earlier unblock request.',
  checking: 'Checking the current task state…', checkState: 'Check task state', checkFailed: 'The current task state could not be read. Task changes remain unavailable until it can be read.',
  networkError: 'The unblock request did not receive a confirmed response from the service.',
  protocolError: 'The service response could not confirm the unblock request result.',
  versionConflict: 'The task version changed before the unblock request could be applied.',
  notFound: 'The task or project is no longer available.', refused: 'The service refused the unblock request.', requestFailed: 'The unblock request failed.',
};
