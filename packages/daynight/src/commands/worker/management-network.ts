/** Missing credentials cannot authorize a request or settle an earlier cloud operation. */
export class WorkerNetworkUnavailableError extends Error {
  readonly code = "credentials_unavailable";
  constructor() {
    super("Original Worker credentials are unavailable; cloud responsibility remains pending.");
    this.name = "WorkerNetworkUnavailableError";
  }
}

export const requireWorkerNetworkToken = (token: string | undefined): string => {
  if (token === undefined) throw new WorkerNetworkUnavailableError();
  return token;
};

export const workerNetworkUnavailable = async (): Promise<never> => { throw new WorkerNetworkUnavailableError(); };

/** Only an explicitly local management owner may be constructed without credentials. */
export const workerManagementToken = (token: string | undefined, managementOnly = false): string | undefined => {
  if (!managementOnly) return requireWorkerNetworkToken(token);
  return token;
};
