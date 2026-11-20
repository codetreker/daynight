import path from "node:path";
import { resolveConfigurationPaths } from "../../config/paths.js";
import type { ConfigurationPaths } from "../../config/paths.js";
import type { PathApi } from "../../platform/filesystem.js";

export type ReviewPaths = ConfigurationPaths & {
  databaseFile: string;
  lockFile: string;
  copilotDirectory: string;
  cacheDirectory: string;
  temporaryDirectory: string;
  logsDirectory: string;
};

export const resolveReviewPaths = (
  homeDirectory: string,
  pathApi: PathApi = path,
): ReviewPaths => {
  const configurationPaths = resolveConfigurationPaths(homeDirectory, pathApi);
  const { stateDirectory } = configurationPaths;
  return {
    ...configurationPaths,
    databaseFile: pathApi.join(stateDirectory, "state.sqlite"),
    lockFile: pathApi.join(stateDirectory, "instance.lock"),
    copilotDirectory: pathApi.join(stateDirectory, "copilot"),
    cacheDirectory: pathApi.join(stateDirectory, "cache"),
    temporaryDirectory: pathApi.join(stateDirectory, "tmp"),
    logsDirectory: pathApi.join(stateDirectory, "logs"),
  };
};

export const resolveWorkerReviewPaths = (homeDirectory: string, pathApi: PathApi = path): ReviewPaths => {
  const paths = resolveReviewPaths(homeDirectory, pathApi);
  const stateDirectory = pathApi.join(paths.stateDirectory, "reviewer");
  return { ...paths, stateDirectory, databaseFile: pathApi.join(stateDirectory, "state.sqlite"),
    lockFile: pathApi.join(stateDirectory, "instance.lock"), copilotDirectory: pathApi.join(stateDirectory, "copilot"),
    cacheDirectory: pathApi.join(stateDirectory, "cache"), temporaryDirectory: pathApi.join(stateDirectory, "tmp"),
    logsDirectory: pathApi.join(stateDirectory, "logs") };
};
