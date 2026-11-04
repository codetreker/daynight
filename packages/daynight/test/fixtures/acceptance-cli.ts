import { inject } from "vitest";
import type { InstalledCliOptions, InstalledCliReceipt } from "./installed-cli.js";
import { createInstalledCliView } from "./installed-cli-view.js";

declare module "vitest" {
  export interface ProvidedContext {
    installedCli: InstalledCliReceipt;
  }
}

export const createAcceptanceCli = (options: InstalledCliOptions & { readonly writablePackage?: boolean } = {}) =>
  createInstalledCliView(inject("installedCli"), options);
