import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const apiProxy = { target: "http://127.0.0.1:8787", changeOrigin: false };
const callbackURL = process.env.DAYNIGHT_UNIAUTH_CALLBACK_URL;
const callbackPath = callbackURL === undefined ? undefined : new URL(callbackURL).pathname;

export const normalizeDevConfigPath = (path: string): string => path.replaceAll("\\", "/");

const developmentPreview = (): Plugin => {
  let origin: string | undefined;
  return {
    name: "daynight-development-preview-origin",
    apply: (_config, environment) => environment.command === "serve" && !environment.isPreview,
    configResolved(config) {
      // Custom fixture configurations own their own shell metadata.
      if (config.configFile !== normalizeDevConfigPath(resolve(config.root, "vite.config.ts"))) return;
      const value = process.env.DAYNIGHT_PREVIEW_ORIGIN;
      try {
        if (value === undefined) throw new Error("missing");
        const url = new URL(value);
        const hostname = url.hostname;
        const labels = hostname.split(".");
        if (url.origin !== value || !["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" ||
          hostname.length > 216 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
          url.protocol === "http:" && !hostname.endsWith(".localhost") && !hostname.endsWith(".test")) throw new Error("invalid");
        const expected = `00000000-0000-4000-8000-000000000001.${hostname}`;
        url.hostname = expected;
        if (url.hostname !== expected) throw new Error("invalid");
        origin = value;
      } catch {
        throw new Error("Set DAYNIGHT_PREVIEW_ORIGIN to the Go server's exact preview origin using a DNS hostname (for example http://preview.daynight.localhost:8787). Numeric IPs, paths, and credentials are not supported.");
      }
    },
    transformIndexHtml(_html, context) {
      return context.server !== undefined && origin !== undefined
        ? [{ tag: "meta", attrs: { name: "daynight-preview-origin", content: origin }, injectTo: "head-prepend" }]
        : [];
    },
  };
};

export default defineConfig({
  plugins: [react(), developmentPreview()],
  cacheDir: ".tmp/vite",
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": apiProxy,
      ...(callbackPath === undefined ? {} : { [`^${callbackPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\?|$)`]: apiProxy }),
    },
  },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
