// Exercises one self-contained prototype in a caller-owned Playwright page: every option of every
// inspection control, visible enabled actions inside the product area, keyboard reachability,
// unclipped horizontal overflow of elements or their text, and access to persistent browser storage. It does not launch a
// browser, open files or write anything; the caller owns the context, navigation and cleanup.

// Install with `context.addInitScript({ content: storageProbeScript })` before opening the
// prototype. Each property access records its name, so a prototype that persists state is
// reported even when it catches the resulting error.
export const storageProbeScript = `(() => {
  const record = (name) => { (globalThis.__prototypeStorageAccess ||= []).push(name); };
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches"]) {
    try { Object.defineProperty(globalThis, name, { configurable: true, get() { record(name); return undefined; } }); }
    catch { record(name + ":unpatched"); }
  }
  try {
    Object.defineProperty(Document.prototype, "cookie", { configurable: true, get() { record("cookie"); return ""; }, set() { record("cookie"); } });
  } catch { record("cookie:unpatched"); }
})();`;

const defaults = {
  area: "#device",
  controls: ".proto-bar select",
  actions: "button:not([disabled]), summary, [role='button']:not([aria-disabled='true'])",
  maxActionsPerState: 12,
  settleMs: 120,
  actionTimeoutMs: 2000,
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

// Runs inside the page and must stay self-contained: Playwright serializes it.
function pageProbe(input) {
  const area = document.querySelector(input.area);
  if (!area) return { missingArea: true };
  const key = (element) => {
    const parts = [];
    for (let node = element; node && node !== area; node = node.parentElement) {
      const parent = node.parentElement;
      const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
      parts.unshift(`${node.tagName.toLowerCase()}:${index}`);
    }
    return parts.join(">");
  };
  const visible = (element) => {
    if (typeof element.checkVisibility === "function") return element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true, contentVisibilityAuto: true });
    return element.getClientRects().length > 0;
  };
  // Content of a closed <details> stays laid out in some engines but cannot receive focus.
  const hiddenByDetails = (element) => {
    const details = element.closest("details:not([open])");
    return Boolean(details && area.contains(details) && element !== details.querySelector(":scope > summary"));
  };
  switch (input.op) {
    case "controls":
      return Array.from(document.querySelectorAll(input.controls)).map((select, index) => ({
        index,
        label: (select.labels?.[0]?.textContent ?? select.getAttribute("aria-label") ?? select.id ?? "").trim(),
        values: Array.from(select.options ?? []).filter((option) => !option.disabled).map((option) => option.value),
      }));
    case "actions":
      return Array.from(area.querySelectorAll(input.actions)).filter((element) => visible(element) && !hiddenByDetails(element) && !element.closest("[inert]")).length;
    case "overflow": {
      const box = area.getBoundingClientRect();
      const clips = (node) => ["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(node).overflowX);
      const clipped = (element) => {
        for (let node = element.parentElement; node && node !== area; node = node.parentElement) {
          if (clips(node)) return true;
        }
        return false;
      };
      const beyond = (rect) => rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1);
      // An element's border box does not contain text painted past it, such as unwrapped text in
      // a narrow block. Measuring the element's own text nodes finds that overflow without also
      // reporting every ancestor whose scroll extent grows with it.
      const ownTextBeyond = (element) => !clips(element) && Array.from(element.childNodes).some((node) => {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return false;
        const range = document.createRange();
        range.selectNodeContents(node);
        return beyond(range.getBoundingClientRect());
      });
      return Array.from(area.querySelectorAll("*")).filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).position !== "fixed"
          && (beyond(rect) || ownTextBeyond(element)) && !clipped(element);
      }).slice(0, 10).map((element) => `${key(element)}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}`);
    }
    case "tabbable": {
      const focusable = "a[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable='true'], audio[controls], video[controls]";
      const usable = (element) => !element.disabled && element.tabIndex >= 0 && visible(element) && !hiddenByDetails(element) && !element.closest("[inert]");
      // The page-wide count sizes the Tab budget, because inspection controls precede the product area.
      return { keys: Array.from(area.querySelectorAll(focusable)).filter(usable).map(key), total: Array.from(document.querySelectorAll(focusable)).filter(usable).length };
    }
    case "focused": {
      const active = document.activeElement;
      return active && active !== area && area.contains(active) ? key(active) : null;
    }
    case "storage":
      return globalThis.__prototypeStorageAccess ?? [];
    default:
      throw new Error(`Unknown probe operation: ${input.op}`);
  }
}

export async function checkPrototype(page, options = {}) {
  const settings = { ...defaults, ...options };
  check(Number.isInteger(settings.maxActionsPerState) && settings.maxActionsPerState >= 0, "maxActionsPerState must be a nonnegative integer.");
  const probe = (input) => page.evaluate(pageProbe, { ...input, area: settings.area, controls: settings.controls, actions: settings.actions });
  const errors = [];
  const onPageError = (error) => errors.push({ kind: "pageerror", message: String(error?.message ?? error).slice(0, 300) });
  const onConsole = (message) => { if (message.type() === "error") errors.push({ kind: "console", message: message.text().slice(0, 300) }); };
  const onDialog = (dialog) => { errors.push({ kind: "dialog", message: dialog.type() }); dialog.dismiss().catch(() => {}); };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);
  page.on("dialog", onDialog);
  try {
    const controls = await probe({ op: "controls" });
    check(Array.isArray(controls), `The product area ${settings.area} was not found.`);
    const overflow = [];
    // The access log lives in the page, so navigation or reload discards it. Collect it after each
    // state and before the keyboard reload instead of reading it only at the end.
    const storage = [];
    const collectStorage = async () => {
      for (const name of await probe({ op: "storage" })) if (!storage.includes(name)) storage.push(name);
    };
    let states = 0, actionsClicked = 0, actionFailures = 0;
    const exerciseState = async (label) => {
      states++;
      const offenders = await probe({ op: "overflow" });
      if (offenders.length) overflow.push({ state: label, elements: offenders });
      const count = Math.min(await probe({ op: "actions" }), settings.maxActionsPerState);
      for (let index = 0; index < count; index++) {
        // Earlier clicks can add or remove actions; a vanished target is counted, not fatal.
        try {
          await page.click(`${settings.area} :is(${settings.actions}) >> visible=true >> nth=${index}`, { timeout: settings.actionTimeoutMs });
          actionsClicked++;
        } catch { actionFailures++; }
        await page.waitForTimeout(settings.settleMs);
      }
      await collectStorage();
    };
    if (controls.length === 0) await exerciseState("initial");
    for (const control of controls) {
      for (const value of control.values) {
        await page.selectOption(`${settings.controls} >> nth=${control.index}`, value);
        await page.waitForTimeout(settings.settleMs);
        await exerciseState(`${control.label || `control ${control.index}`}=${value}`);
      }
    }

    // Keyboard reachability is checked from the initial state the prototype restores on reload.
    await collectStorage();
    await page.reload();
    await page.waitForTimeout(settings.settleMs);
    const { keys: tabbable, total } = await probe({ op: "tabbable" });
    const reached = new Set();
    for (let press = 0; press < total * 2 + 8; press++) {
      await page.keyboard.press("Tab");
      const focused = await probe({ op: "focused" });
      if (focused) reached.add(focused);
    }
    const missing = tabbable.filter((item) => !reached.has(item));
    await collectStorage();
    return {
      ok: errors.length === 0 && storage.length === 0 && overflow.length === 0 && missing.length === 0,
      controls: controls.map((control) => ({ label: control.label, values: control.values.length })),
      states,
      actionsClicked,
      actionFailures,
      overflow,
      focus: { tabbable: tabbable.length, reached: reached.size, missing },
      storage,
      errors,
    };
  } finally {
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    page.off("dialog", onDialog);
  }
}
