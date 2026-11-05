import { createHash } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const fail = (code, message) => Object.assign(new Error(message), { code });
const normalizeText = (value) => value.replace(/\s+/gu, " ").trim();
const textOption = (value, name, limit) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /\p{Cc}/u.test(value)) throw new Error(`${name} must be nonempty text of at most ${limit} characters without control characters.`);
  return value;
};
const selectorOption = (value) => {
  const selector = textOption(value, "selector", 512);
  if (selector.split(",").some((part) => /^(?:html|body|:root|\*)$/i.test(part.trim()))) throw new Error("Use a specific semantic element, not the whole document, as a selector.");
  return selector;
};
const loopbackOrigin = (value) => {
  const url = new URL(value);
  const loopback = ["localhost", "[::1]"].includes(url.hostname) || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("expectedOrigin must be a localhost or loopback HTTP(S) origin without credentials, path, query or fragment.");
  return url.origin;
};
const validate = (options) => {
  const expectedOrigin = loopbackOrigin(options.expectedOrigin);
  if (!/^[0-9a-f]{40}$/i.test(options.source?.commit ?? "") || typeof options.source?.dirty !== "boolean") throw new Error("source must include a full 40-character Git commit and an explicit dirty boolean.");
  const source = { commit: options.source.commit.toLowerCase(), dirty: options.source.dirty };
  if (options.source.build !== undefined) source.build = textOption(options.source.build, "source.build", 160);
  if (!Array.isArray(options.ready) || !options.ready.length || options.ready.length > 12) throw new Error("ready must contain 1 to 12 semantic conditions.");
  const ready = options.ready.map(({ selector, text }) => ({ selector: selectorOption(selector), text: normalizeText(textOption(text, "ready.text", 240)) }));
  if (!Array.isArray(options.observe) || options.observe.length > 24) throw new Error("observe must be an explicit selector allowlist of at most 24 entries; use [] when no geometry is needed.");
  const observe = options.observe.map(({ name, selector, includeText = false }) => {
    if (typeof includeText !== "boolean") throw new Error("includeText must be a boolean.");
    return { name: textOption(name, "observation name", 80), selector: selectorOption(selector), includeText };
  });
  if (new Set(observe.map(({ name }) => name)).size !== observe.length) throw new Error("Observation names must be unique.");
  if (!["screenshot", "screen-pdf", "geometry"].includes(options.mode)) throw new Error("Select mode explicitly: screenshot, screen-pdf or geometry.");
  if (options.mode === "screen-pdf" && options.screenMediaConfirmed !== true) throw new Error("screen-pdf requires screenMediaConfirmed=true after the caller explicitly selects screen media on its owned page.");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("timeoutMs must be an integer between 1 and 60000.");
  if (typeof options.outputDir !== "string" || !path.isAbsolute(options.outputDir) || path.resolve(options.outputDir) !== options.outputDir || options.outputDir === path.parse(options.outputDir).root || /\p{Cc}/u.test(options.outputDir)) throw new Error("outputDir must be a normalized absolute path to a new directory.");
  return { expectedOrigin, source, ready, observe, mode: options.mode, timeoutMs };
};

// This function runs in the page. It reads only the requested elements and never form values.
function sampleDom({ ready, observe }) {
  const normalized = (value) => value.replace(/\s+/gu, " ").trim();
  const excluded = "input, textarea, select, option, [contenteditable], script, style, noscript, template";
  const safeText = (element) => {
    if (element.closest(excluded)) return "";
    const copy = element.cloneNode(true);
    copy.querySelectorAll(excluded).forEach((node) => node.remove());
    return normalized(copy.textContent ?? "");
  };
  const elements = (selector) => {
    const matches = [...document.querySelectorAll(selector)];
    if (matches.length > 24) throw new Error("A selector matched more than 24 elements; narrow it before collecting evidence.");
    return matches;
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const rendered = typeof element.checkVisibility !== "function" || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    return rendered && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity) !== 0;
  };
  const round = (value) => Math.round(value * 100) / 100;
  return {
    location: { origin: location.origin, pathname: location.pathname },
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    document: { visibility: document.visibilityState, focused: document.hasFocus(), screenMedia: matchMedia("screen").matches, language: document.documentElement.lang },
    ready: ready.map((condition) => {
      const matches = elements(condition.selector);
      const visibleMatches = matches.filter((element) => visible(element) && safeText(element) === condition.text).length;
      return { ...condition, matches: matches.length, visibleMatches, satisfied: visibleMatches > 0 };
    }),
    observations: observe.map(({ name, selector, includeText }) => {
      const matches = elements(selector);
      return {
        name, selector, count: matches.length,
        elements: matches.map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const measurement = {
            rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
            visible: visible(element), clientWidth: element.clientWidth, clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
            style: { fontSize: style.fontSize, lineHeight: style.lineHeight, whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflowX: style.overflowX, overflowY: style.overflowY },
          };
          if (includeText) measurement.text = safeText(element).slice(0, 240);
          return measurement;
        }),
      };
    }),
  };
}

/** Capture an already-owned localhost Page. The caller owns browser setup, UI actions and teardown. */
export async function captureUiEvidence(page, options) {
  const settings = validate(options);
  for (const method of ["url", "evaluate", "mainFrame", "on", "off", ...(settings.mode === "screenshot" ? ["screenshot"] : settings.mode === "screen-pdf" ? ["pdf"] : [])]) {
    if (typeof page?.[method] !== "function") throw new Error(`page.${method} must be available.`);
  }
  let foreignOrigin = false;
  let navigations = 0;
  const assertOrigin = () => {
    const url = new URL(page.url());
    if (foreignOrigin || url.origin !== settings.expectedOrigin || url.username || url.password) throw fail("ORIGIN_CHANGED", "Page origin does not match expectedOrigin.");
    return url.href;
  };
  assertOrigin();
  const parent = await realpath(path.dirname(options.outputDir));
  if (!(await stat(parent)).isDirectory()) throw new Error("outputDir parent must be an existing directory.");
  const directory = path.join(parent, path.basename(options.outputDir));
  // mkdir is exclusive; an existing directory, file or symlink must never be reused.
  await mkdir(directory, { mode: 0o700 });
  const started = performance.now();
  const remaining = () => Math.max(0, settings.timeoutMs - (performance.now() - started));
  const bounded = async (operation) => {
    const milliseconds = remaining();
    if (milliseconds <= 0) throw fail("TIMEOUT", "The evidence deadline elapsed.");
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail("TIMEOUT", "The evidence deadline elapsed.")), milliseconds); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const onNavigation = (frame) => {
    if (frame !== page.mainFrame()) return;
    navigations += 1;
    try { assertOrigin(); } catch { foreignOrigin = true; }
  };
  const sample = async () => {
    const url = assertOrigin();
    const observed = await bounded(() => page.evaluate(sampleDom, { ready: settings.ready, observe: settings.observe }));
    assertOrigin();
    if (observed.location.origin !== settings.expectedOrigin) throw fail("ORIGIN_CHANGED", "Observed document origin changed.");
    return { ...observed, routeFingerprint: createHash("sha256").update(url).digest("hex") };
  };
  const record = {
    format: "daynight-ui-evidence-v1", source: settings.source, expectedOrigin: settings.expectedOrigin,
    mode: settings.mode, startedAt: new Date().toISOString(), timeoutMs: settings.timeoutMs,
    status: "failed", before: null, after: null, artifact: null, changes: [],
  };
  let stage = "readiness";
  let artifactBytes;
  page.on("framenavigated", onNavigation);
  try {
    for (;;) {
      const observed = await sample();
      if (observed.ready.every(({ satisfied }) => satisfied)) {
        record.before = observed;
        delete record.lastReadiness;
        break;
      }
      record.lastReadiness = observed;
      await bounded(() => new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining()))));
    }
    const initialNavigations = navigations;
    assertOrigin();
    if (settings.mode === "screenshot") {
      stage = "screenshot";
      artifactBytes = await bounded(() => page.screenshot({ type: "png", fullPage: false, timeout: Math.max(1, Math.ceil(remaining())), animations: "allow", caret: "initial", scale: "css" }));
      record.artifact = { kind: "screenshot", path: "screen.png", compositorScreenshot: true };
    } else if (settings.mode === "screen-pdf") {
      stage = "screen-pdf";
      if (!record.before.document.screenMedia) throw fail("SCREEN_MEDIA_REQUIRED", "The owned page must use screen media before PDF capture.");
      artifactBytes = await bounded(() => page.pdf({
        width: `${record.before.viewport.width}px`, height: `${record.before.viewport.height}px`,
        margin: { top: "0", right: "0", bottom: "0", left: "0" }, printBackground: true, preferCSSPageSize: false, scale: 1,
      }));
      record.artifact = { kind: "screen-media-pdf", path: "screen.pdf", compositorScreenshot: false };
    }
    stage = "after-capture";
    record.after = await sample();
    for (const key of Object.keys(record.before)) {
      if (JSON.stringify(record.before[key]) !== JSON.stringify(record.after[key])) record.changes.push(key);
    }
    if (navigations !== initialNavigations) record.changes.push("navigation");
    record.status = record.changes.length ? "inconsistent" : "consistent";
  } catch (error) {
    record.status = "failed";
    record.artifact = null;
    // Browser error messages can contain request URLs or page text. Retain the stage and error class only.
    record.failure = { stage, code: error.code === "TIMEOUT" || error.name === "TimeoutError" ? "TIMEOUT" : ["ORIGIN_CHANGED", "SCREEN_MEDIA_REQUIRED"].includes(error.code) ? error.code : "OPERATION_FAILED", name: /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(error.name ?? "") ? error.name : "Error" };
  } finally { page.off("framenavigated", onNavigation); }
  record.finishedAt = new Date().toISOString();
  let artifactPath;
  if (record.artifact) {
    artifactPath = path.join(directory, record.artifact.path);
    await writeFile(artifactPath, artifactBytes, { flag: "wx", mode: 0o600 });
  }
  const manifestPath = path.join(directory, "evidence.json");
  await writeFile(manifestPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { status: record.status, directory, manifestPath, ...(artifactPath ? { artifactPath } : {}) };
}
