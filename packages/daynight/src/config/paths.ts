import path from "node:path";
import type { PathApi } from "../platform/filesystem.js";

export type ConfigurationPaths = {
  stateDirectory: string;
  configFile: string;
};

export const resolveConfigurationPaths = (
  homeDirectory: string,
  pathApi: PathApi = path,
): ConfigurationPaths => {
  if (!pathApi.isAbsolute(homeDirectory)) {
    throw new Error("The current user's home directory must be an absolute path.");
  }
  const stateDirectory = pathApi.resolve(homeDirectory, ".daynight");
  return { stateDirectory, configFile: pathApi.join(stateDirectory, "config.yml") };
};
