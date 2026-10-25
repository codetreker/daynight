import { spawn } from "node:child_process";

export const openBrowser = async (url: string, signal: AbortSignal): Promise<void> => {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]] as const
    : process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const
      : ["xdg-open", [url]] as const;
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true, signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, exitedSignal) => {
      if (code === 0) resolve();
      else reject(new Error(`Browser opener failed (${exitedSignal ?? code}).`));
    });
  });
};
