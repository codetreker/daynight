export type WorkerFixtureConfiguration = {
  serverUrl: string;
  serverToken: string;
  workerId: string;
  repositoryRoot: string;
  peer: string;
  projectId: string;
  remote: string;
  repository: string;
};

// The Worker uses the existing CLI credential in an isolated configuration.
export const workerFixtureConfiguration = (input: WorkerFixtureConfiguration): string => `${JSON.stringify({
  serverUrl: input.serverUrl,
  serverToken: input.serverToken,
  workerId: input.workerId,
  worker: {
    agentControlMode: "web", agent: "codex", pollIntervalMs: 1000, maxConcurrent: 1,
    repositoryRoot: input.repositoryRoot, toolPaths: { codex: input.peer },
    repositories: [{ projectId: input.projectId, remote: input.remote, path: input.repository }],
  },
}, null, 2)}\n`;
