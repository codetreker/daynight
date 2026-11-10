/** Match Node's Windows environment-key selection before searching or spawning. */
export const captureToolEnvironment = (environment: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv => {
  const captured = { ...environment };
  if (platform === "win32") {
    const keys = Object.keys(captured).sort();
    for (const name of ["PATH", "PATHEXT"]) {
      const matches = keys.filter(key => key.toUpperCase() === name);
      if (matches.length === 0) continue;
      const value = captured[matches[0]!];
      for (const key of matches) delete captured[key];
      captured[name] = value;
    }
  }
  return captured;
};
