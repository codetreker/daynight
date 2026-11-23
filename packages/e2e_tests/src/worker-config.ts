import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type WorkerFixtureConfiguration = {
  serverUrl: string;
  serverToken: string;
  workerId: string;
  repositoryRoot: string;
  peer: string;
  projectId: string;
  remote: string;
  repository: string;
  // Hosted Bots verify and call the compiled CLI through this launcher.
  cli: string;
};

// The Worker uses the existing CLI credential in an isolated configuration.
export const workerFixtureConfiguration = (input: WorkerFixtureConfiguration): string => `${JSON.stringify({
  serverUrl: input.serverUrl,
  serverToken: input.serverToken,
  workerId: input.workerId,
  agentCliAliases: { daynight: input.cli },
  worker: {
    agentControlMode: "web", agent: "codex", pollIntervalMs: 1000, maxConcurrent: 1,
    repositoryRoot: input.repositoryRoot, toolPaths: { codex: input.peer },
    repositories: [{ projectId: input.projectId, remote: input.remote, path: input.repository }],
  },
}, null, 2)}\n`;

// A fresh directory prevents another CLI or Worker identity's cache from being adopted.
export const prepareWorkerFixtureConfiguration = async (root: string, input: WorkerFixtureConfiguration): Promise<string> => {
  const directory = path.join(root, "worker-config");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, "config.yml"), workerFixtureConfiguration(input), { mode: 0o600, flag: "wx" });
  return directory;
};
