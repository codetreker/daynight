import path from "node:path";
import type { PathApi } from "../platform/filesystem.js";

export type ConfigurationPaths = {
  stateDirectory: string;
  configFile: string;
};

export const resolveConfigurationPaths = (
  homeDirectory: string,
  pathApi: PathApi = path,
  environment: NodeJS.ProcessEnv = process.env,
): ConfigurationPaths => {
  if (!pathApi.isAbsolute(homeDirectory)) {
    throw new Error("The current user's home directory must be an absolute path.");
  }
  const configured = environment.DN_CONFIG_DIR;
  if (configured !== undefined && (!pathApi.isAbsolute(configured) || /\p{Cc}/u.test(configured))) {
    throw new Error("DN_CONFIG_DIR must be an absolute path without control characters.");
  }
  const stateDirectory = configured === undefined ? pathApi.resolve(homeDirectory, ".daynight") : pathApi.resolve(configured);
  return { stateDirectory, configFile: pathApi.join(stateDirectory, "config.yml") };
};
