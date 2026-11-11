import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export type Environment = {
  baseURL: string; authURL: string; proxyURL: string;
  resourceIdentity: { network: string; ingressNetwork: string; applicationContainer: string; postgresContainer: string };
  startServer(credentials: { appId: string; appSecret: string }): Promise<void>;
  close(): Promise<void>;
};
export type RunCommand = (command: string, args: readonly string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number;
  onOutput?: (channel: "stdout" | "stderr", text: string) => void;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Use the existing isolated OAuth provider with its explicit CA, never -k. */
export async function authenticate(options: {
  environment: Environment; directory: string; artifacts: string; repository: string;
  run: RunCommand; signal: AbortSignal;
}): Promise<{ token: string; tokenId: string; userId: string }> {
  const { environment, directory, run } = options;
  const cookie = path.join(directory, "auth-cookies.txt");
  await writeFile(cookie, "", { mode: 0o600 });
  let sequence = 0;
  const request = async (url: string, body?: unknown, csrf?: string): Promise<{ status: number; text: string }> => {
    const output = path.join(directory, `auth-response-${++sequence}`);
    const args = ["--silent", "--show-error", "--max-time", "30", "--max-redirs", "8", "--location",
      "--cookie", cookie, "--cookie-jar", cookie, "--cacert", path.join(options.artifacts, "provider-ca.pem"),
      "--proxy", environment.proxyURL, "--noproxy", "127.0.0.1,localhost", "--output", output, "--write-out", "%{http_code}"];
    if (body !== undefined) {
      const input = path.join(directory, `auth-request-${sequence}`);
      const form = body instanceof URLSearchParams;
      await writeFile(input, form ? body.toString() : JSON.stringify(body), { mode: 0o600 });
      args.push("--header", `Content-Type: ${form ? "application/x-www-form-urlencoded" : "application/json"}`, "--data-binary", `@${input}`);
      if (!form) args.push("--header", `Origin: ${new URL(url).origin}`);
    }
    if (csrf) args.push("--header", `X-CSRF-Token: ${csrf}`);
    args.push(url);
    let status: number;
    try {
      const result = await run("curl", args, { cwd: options.repository, signal: options.signal, timeoutMs: 35_000, onOutput() {} });
      status = Number(result.stdout);
    } catch { throw new Error("Isolated OAuth HTTP request failed; private auth responses remain in the owned run directory."); }
    assert(Number.isInteger(status) && status >= 100 && status <= 599);
    return { status, text: await readFile(output, "utf8") };
  };
  const json = async (url: string, status: number, body?: unknown, csrf?: string): Promise<Record<string, any>> => {
    const response = await request(url, body, csrf);
    assert.equal(response.status, status, `Isolated auth endpoint ${new URL(url).pathname}`);
    return JSON.parse(response.text) as Record<string, any>;
  };
  const authorize = async (url: string): Promise<void> => {
    const page = await request(url);
    assert.equal(page.status, 200);
    const requestId = page.text.match(/name="request" value="([A-Za-z0-9_-]+)"/)?.[1];
    assert(requestId, "The isolated provider must present its real authorization form.");
    const response = await request("https://github.com/login/oauth/authorize", new URLSearchParams({ request: requestId }));
    assert.equal(response.status, 200);
  };
  const login = await json(`${environment.authURL}/console/api/login`, 200, { provider: "github" });
  assert.equal(typeof login.authorization_url, "string");
  await authorize(login.authorization_url);
  const account = await json(`${environment.authURL}/console/api/session`, 200);
  assert.equal(typeof account.csrf_token, "string");
  const app = await json(`${environment.authURL}/console/api/apps`, 201, {
    name: "External image source regression", enabled: true,
    redirect_uris: [`${environment.baseURL}/auth/callback`], providers: ["github"],
    initial_secret: { name: "Isolated backend" },
  }, account.csrf_token);
  assert.equal(typeof app.app?.id, "string"); assert.equal(typeof app.secret, "string");
  await environment.startServer({ appId: app.app.id, appSecret: app.secret });
  await authorize(`${environment.baseURL}/api/v1/auth/login?provider=github&returnPath=%2Fprojects`);
  const minted = await json(`${environment.baseURL}/api/v1/me/tokens`, 201, {
    name: "External image source regression", expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const principal = await json(`${environment.baseURL}/api/v1/me`, 200);
  assert.equal(typeof minted.token, "string"); assert.equal(typeof minted.id, "string");
  assert.equal(typeof principal.id, "string");
  return { token: minted.token, tokenId: minted.id, userId: principal.id };
}
