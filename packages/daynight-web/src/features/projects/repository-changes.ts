type RepositoryChange = { readonly userId: string; readonly projectId: string };
const listeners = new Set<(change: RepositoryChange) => void>();
export const publishRepositoryChange = (change: RepositoryChange): void => { for (const listener of listeners) listener(change); };
export const subscribeRepositoryChanges = (listener: (change: RepositoryChange) => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
