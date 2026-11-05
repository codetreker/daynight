import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { captureUiEvidence } from "./capture-ui-evidence.mjs";

const source = { commit: "a".repeat(40), dirty: false };
const ready = [{ selector: "#assistant-name", text: "Layout fixture" }, { selector: "#state", text: "Ready" }];
const observe = [{ name: "heading", selector: "h1" }];
const snapshot = (overrides = {}) => ({
  location: { origin: "http://127.0.0.1:5173", pathname: "/bots/test" },
  viewport: { width: 390, height: 844, devicePixelRatio: 1 },
  document: { visibility: "visible", focused: true, screenMedia: true },
  ready: ready.map((condition) => ({ ...condition, matches: 1, visibleMatches: 1, satisfied: true })),
  observations: [{ name: "heading", selector: "h1", count: 1, elements: [{ rect: { x: 20, y: 20, width: 350, height: 30 }, visible: true }] }],
  ...overrides,
});

function fakePage({ snapshots = [snapshot()], url = "http://127.0.0.1:5173/bots/test", screenshot, pdf, evaluate } = {}) {
  let calls = 0;
  const events = new Map();
  const page = {
    methods: [],
    url: () => url,
    mainFrame: () => page,
    on: (event, listener) => events.set(event, listener),
    off: (event, listener) => { if (events.get(event) === listener) events.delete(event); },
    navigate: (next) => { url = next; events.get("framenavigated")?.(page); },
    evaluate: async (fn, args) => {
      page.methods.push({ method: "evaluate", args });
      if (evaluate) return evaluate(fn, args);
      return snapshots[Math.min(calls++, snapshots.length - 1)];
    },
    screenshot: async (options) => {
      page.methods.push({ method: "screenshot", options });
      return screenshot ? screenshot(page) : Buffer.from("PNG fixture");
    },
    pdf: async (options) => {
      page.methods.push({ method: "pdf", options });
      return pdf ? pdf(page) : Buffer.from("PDF fixture");
    },
  };
  return page;
}

async function setup(t) {
  const scratch = path.resolve(import.meta.dirname, "../../../../.tmp");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, "ui-evidence-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, options: { expectedOrigin: "http://127.0.0.1:5173", source, ready, observe, mode: "screenshot", outputDir: path.join(directory, "capture"), timeoutMs: 1000 } };
}

async function manifest(result) { return JSON.parse(await readFile(result.manifestPath, "utf8")); }

test("rejects unsafe origins, missing source identity and nonsemantic readiness before reading the page", async (t) => {
  const { options, directory } = await setup(t);
  const cases = [
    { expectedOrigin: "https://daynight.cc" },
    { expectedOrigin: "http://localhost.attacker.test" },
    { expectedOrigin: "http://user:password@localhost:5173" },
    { expectedOrigin: "http://127.0.0.1:5173/path" },
    { source: { commit: "short", dirty: false } },
    { source: { commit: source.commit } },
    { ready: [] },
    { ready: [{ selector: "body", text: "Ready" }] },
    { ready: [{ selector: "#state" }] },
    { timeoutMs: Infinity },
  ];
  for (const invalid of cases) {
    const page = fakePage();
    await assert.rejects(captureUiEvidence(page, { ...options, ...invalid }));
    assert.equal(page.methods.length, 0);
  }
  await assert.rejects(captureUiEvidence(fakePage({ url: "http://localhost:5173/bots/test" }), options), /origin/i);
  assert.deepEqual(await readdir(directory), []);
});

test("captures one consistent semantic state with private geometry and screenshot artifacts", async (t) => {
  const { options } = await setup(t);
  const page = fakePage();
  const result = await captureUiEvidence(page, options);
  const record = await manifest(result);
  assert.equal(result.status, "consistent");
  assert.equal(record.format, "daynight-ui-evidence-v1");
  assert.deepEqual(record.source, source);
  assert.deepEqual(record.before, record.after);
  assert.equal(record.artifact.kind, "screenshot");
  assert.equal(await readFile(result.artifactPath, "utf8"), "PNG fixture");
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.artifactPath)).mode & 0o777, 0o600);
  assert.deepEqual(page.methods.map((call) => call.method), ["evaluate", "screenshot", "evaluate"]);
  assert.equal(page.methods[1].options.fullPage, false);
  assert.equal(page.methods[1].options.path, undefined);
});

test("waits for exact semantic readiness and never combines loading geometry with a ready artifact", async (t) => {
  const { options } = await setup(t);
  const loading = snapshot({ ready: ready.map((condition) => ({ ...condition, matches: 1, visibleMatches: 0, satisfied: false })), observations: [] });
  const page = fakePage({ snapshots: [loading, snapshot(), snapshot()] });
  const result = await captureUiEvidence(page, options);
  const record = await manifest(result);
  assert.equal(record.status, "consistent");
  assert.deepEqual(record.before.observations, snapshot().observations);
  assert.equal(page.methods.filter((call) => call.method === "evaluate").length, 3);
});

test("unready pages and bounded operations produce failed evidence without an artifact", async (t) => {
  const { options } = await setup(t);
  const notReady = snapshot({ ready: [{ selector: "#state", text: "Ready", satisfied: false }] });
  const page = fakePage({ snapshots: [notReady] });
  const result = await captureUiEvidence(page, { ...options, timeoutMs: 30 });
  const record = await manifest(result);
  assert.equal(record.status, "failed");
  assert.equal(record.failure.code, "TIMEOUT");
  assert.equal(record.failure.stage, "readiness");
  assert.equal(record.before, null);
  assert.equal(record.lastReadiness.ready[0].satisfied, false);
  assert.equal(result.artifactPath, undefined);
  assert.ok(page.methods.every((call) => call.method === "evaluate"));
});

test("readiness, geometry and query changes invalidate the paired sample", async (t) => {
  const { options, directory } = await setup(t);
  const changed = [
    snapshot({ ready: [{ selector: "#state", text: "Ready", satisfied: false }] }),
    snapshot({ observations: [{ name: "heading", count: 0, elements: [] }] }),
  ];
  for (const [index, after] of changed.entries()) {
    const result = await captureUiEvidence(fakePage({ snapshots: [snapshot(), after] }), { ...options, outputDir: path.join(directory, `changed-${index}`) });
    assert.equal(result.status, "inconsistent");
    assert.equal((await manifest(result)).status, "inconsistent");
  }
  const page = fakePage({ screenshot: (current) => { current.navigate(`${options.expectedOrigin}/bots/test?token=must-not-persist`); return Buffer.from("PNG"); } });
  const result = await captureUiEvidence(page, { ...options, outputDir: path.join(directory, "query") });
  assert.equal(result.status, "inconsistent");
  assert.ok(!(await readFile(result.manifestPath, "utf8")).includes("must-not-persist"));
});

test("navigation outside the expected origin discards visual bytes even when the page returns", async (t) => {
  const { options } = await setup(t);
  const page = fakePage({ screenshot: (current) => {
    current.navigate("https://example.com/private?token=secret");
    current.navigate(`${options.expectedOrigin}/bots/test`);
    return Buffer.from("untrusted page image");
  } });
  const result = await captureUiEvidence(page, options);
  assert.equal(result.status, "failed");
  assert.equal((await manifest(result)).failure.code, "ORIGIN_CHANGED");
  assert.deepEqual(await readdir(result.directory), ["evidence.json"]);
});

test("capture failure is not converted into PDF success", async (t) => {
  const { options } = await setup(t);
  const page = fakePage({ screenshot: () => { const error = new Error("raw diagnostic contains token=secret"); error.name = "TimeoutError"; throw error; } });
  const result = await captureUiEvidence(page, options);
  const record = await manifest(result);
  assert.equal(record.status, "failed");
  assert.equal(record.failure.stage, "screenshot");
  assert.equal(record.failure.name, "TimeoutError");
  assert.equal(result.artifactPath, undefined);
  assert.ok(!JSON.stringify(record).includes("token=secret"));
  assert.ok(!page.methods.some((call) => call.method === "pdf"));
});

test("PDF needs explicit screen-media preparation and remains labeled as print rendering", async (t) => {
  const { options } = await setup(t);
  await assert.rejects(captureUiEvidence(fakePage(), { ...options, mode: "screen-pdf" }), /screenMediaConfirmed/);
  const page = fakePage();
  const result = await captureUiEvidence(page, { ...options, mode: "screen-pdf", screenMediaConfirmed: true });
  const record = await manifest(result);
  assert.equal(record.status, "consistent");
  assert.equal(record.artifact.kind, "screen-media-pdf");
  assert.equal(record.artifact.compositorScreenshot, false);
  const call = page.methods.find((entry) => entry.method === "pdf");
  assert.deepEqual(call.options, { width: "390px", height: "844px", margin: { top: "0", right: "0", bottom: "0", left: "0" }, printBackground: true, preferCSSPageSize: false, scale: 1 });
});

test("geometry mode does not request visual capture", async (t) => {
  const { options } = await setup(t);
  const page = fakePage();
  const result = await captureUiEvidence(page, { ...options, mode: "geometry" });
  assert.equal(result.status, "consistent");
  assert.equal(result.artifactPath, undefined);
  assert.equal((await manifest(result)).artifact, null);
  assert.ok(page.methods.every((call) => call.method === "evaluate"));
});

test("existing files, directories and symlinks are never overwritten", async (t) => {
  const { options, directory } = await setup(t);
  const target = path.join(directory, "target");
  await mkdir(target);
  await writeFile(path.join(target, "keep"), "existing");
  await symlink(target, options.outputDir);
  await assert.rejects(captureUiEvidence(fakePage(), options), /exist/i);
  assert.equal(await readFile(path.join(target, "keep"), "utf8"), "existing");
  await assert.rejects(captureUiEvidence(fakePage(), { ...options, outputDir: target }), /exist/i);
  await assert.rejects(captureUiEvidence(fakePage(), { ...options, outputDir: path.join(target, "keep") }), /exist/i);
});

test("a hanging browser call has an overall deadline", async (t) => {
  const { options } = await setup(t);
  const result = await captureUiEvidence(fakePage({ evaluate: () => new Promise(() => {}) }), { ...options, timeoutMs: 30 });
  assert.equal(result.status, "failed");
  assert.equal((await manifest(result)).failure.code, "TIMEOUT");
});

test("the DOM sampler reads only selected elements and never credential APIs or form values", async (t) => {
  const { options } = await setup(t);
  const requestedSelectors = [];
  const element = (text, form = false) => ({
    closest: () => form ? {} : null,
    cloneNode: () => ({ querySelectorAll: () => [], textContent: text }),
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 100, height: 30 }),
    clientWidth: 100, clientHeight: 30, scrollWidth: 100, scrollHeight: 30,
    get value() { throw new Error("Do not read form values"); },
  });
  const allowed = { "#assistant-name": element("Layout fixture"), "#state": element("Ready"), "h1": element("Sensitive unrequested text"), "#password": element("Secret form value", true) };
  const document = {
    querySelectorAll: (selector) => { requestedSelectors.push(selector); assert.ok(selector in allowed); return [allowed[selector]]; },
    visibilityState: "visible", hasFocus: () => true, documentElement: { lang: "en" },
    get cookie() { throw new Error("Do not read cookies"); },
  };
  const page = fakePage({ evaluate: (fn, args) => {
    const context = {
      document, location: { origin: options.expectedOrigin, pathname: "/bots/test" },
      innerWidth: 390, innerHeight: 844, devicePixelRatio: 1, args,
      matchMedia: () => ({ matches: true }),
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1", fontSize: "16px", lineHeight: "20px", whiteSpace: "normal", textOverflow: "clip", overflowX: "visible", overflowY: "visible" }),
      get localStorage() { throw new Error("Do not read storage"); },
      get sessionStorage() { throw new Error("Do not read storage"); },
    };
    return vm.runInNewContext(`(${fn.toString()})(args)`, context);
  } });
  const result = await captureUiEvidence(page, { ...options, mode: "geometry", observe: [...observe, { name: "password field geometry", selector: "#password", includeText: true }] });
  assert.equal(result.status, "consistent");
  assert.deepEqual([...new Set(requestedSelectors)], Object.keys(allowed));
  const record = await readFile(result.manifestPath, "utf8");
  assert.ok(!record.includes("Secret form value"));
  assert.ok(!record.includes("Sensitive unrequested text"));
});

test("the DOM sampler omits directly selected non-content nodes and their descendants", async (t) => {
  const { options } = await setup(t);
  const element = (tagName, text, parentElement = null) => ({
    tagName, parentElement,
    closest(selector) {
      const selectors = selector.split(",").map((part) => part.trim());
      for (let current = this; current; current = current.parentElement) {
        if (selectors.includes(current.tagName)) return current;
      }
      return null;
    },
    cloneNode: () => ({ querySelectorAll: () => [], textContent: text }),
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 100, height: 30 }),
    clientWidth: 100, clientHeight: 30, scrollWidth: 100, scrollHeight: 30,
  });
  const nodes = {
    "#assistant-name": element("h1", "Layout fixture"),
    "#state": element("span", "Ready"),
    "#ordinary": element("p", "Visible fixture text"),
  };
  for (const tagName of ["script", "style", "noscript", "template"]) {
    nodes[`#${tagName}`] = element(tagName, `sensitive-${tagName}-self`);
    nodes[`#${tagName}-child`] = element("span", `sensitive-${tagName}-child`, nodes[`#${tagName}`]);
  }
  const page = fakePage({ evaluate: (fn, args) => vm.runInNewContext(`(${fn.toString()})(args)`, {
    args,
    document: {
      querySelectorAll: (selector) => { assert.ok(selector in nodes); return [nodes[selector]]; },
      visibilityState: "visible", hasFocus: () => true, documentElement: { lang: "en" },
    },
    location: { origin: options.expectedOrigin, pathname: "/bots/test" },
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 1,
    matchMedia: () => ({ matches: true }),
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  }) });
  const result = await captureUiEvidence(page, {
    ...options, mode: "geometry",
    observe: Object.keys(nodes).slice(2).map((selector) => ({ name: selector, selector, includeText: true })),
  });
  assert.equal(result.status, "consistent");
  const record = await manifest(result);
  for (const sample of [record.before, record.after]) {
    assert.equal(sample.observations[0].elements[0].text, "Visible fixture text");
    for (const observation of sample.observations.slice(1)) assert.equal(observation.elements[0].text, "", observation.selector);
  }
  assert.ok(!JSON.stringify(record).includes("sensitive-"));
});
