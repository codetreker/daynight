import path from "node:path";
import { resolveConfigurationPaths } from "../../config/paths.js";
import type { ConfigurationPaths } from "../../config/paths.js";
import type { PathApi } from "../../platform/filesystem.js";

export type WorkerPaths = ConfigurationPaths & {
  workerDirectory: string;
  databaseFile: string;
  lockFile: string;
  herdrDirectory: string;
  logsDirectory: string;
  temporaryDirectory: string;
};

export const resolveWorkerPaths = (
  homeDirectory: string,
  pathApi: PathApi = path,
): WorkerPaths => {
  const configurationPaths = resolveConfigurationPaths(homeDirectory, pathApi);
  const workerDirectory = pathApi.join(configurationPaths.stateDirectory, "worker");
  return {
    ...configurationPaths,
    workerDirectory,
    databaseFile: pathApi.join(workerDirectory, "state.sqlite"),
    lockFile: pathApi.join(workerDirectory, "instance.lock"),
    herdrDirectory: pathApi.join(workerDirectory, "h"),
    logsDirectory: pathApi.join(workerDirectory, "logs"),
    temporaryDirectory: pathApi.join(workerDirectory, "tmp"),
  };
};
