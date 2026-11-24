import { expect, it } from "vitest";
import { createLinuxProcessCapture, type LinuxPartialObservation } from "../../../src/commands/controller/linux-process-proof.js";

const pid = 4101, parent = 4000;
const boot = "876b21c9-30d7-48c0-a2ab-287291e903a7";
const stat = `${pid} (node) ${["S", parent, pid, 0, 0, 0, 0, ...Array(12).fill(0), "26140755", 0, 0].join(" ")}\n`;
const ps = `${pid} ${parent} ${pid} S Thu Nov 19 19:43:08 2026 node worker.js\n`;
const stages = ["boot", "stat", "first", "second", "after", "afterBoot"] as const;
const paths = ["/proc/sys/kernel/random/boot_id", `/proc/${pid}/stat`, "ps", "ps", `/proc/${pid}/stat`, "/proc/sys/kernel/random/boot_id"];
const values = [`${boot}\n`, stat, ps, ps, stat, `${boot}\n`];

function fixture(late: number, malformed = false) {
  let time = 0;
  const calls: string[] = [];
  const next = (path: string, timeout: number): string => {
    const index = calls.length;
    calls.push(path);
    expect(path).toBe(paths[index]);
    expect(timeout).toBe(100);
    if (index === late) time = 100;
    return malformed && index === late ? "invalid" : values[index]!;
  };
  const capture = createLinuxProcessCapture(
    async (path, timeout) => next(path, timeout),
    async (actualPid, timeout) => { expect(actualPid).toBe(pid); return next("ps", timeout); },
    command => `hash:${command}`,
    () => time,
  );
  return { capture, calls };
}

it.each(stages.map((stage, index) => ({ stage, index })))("records $stage before reporting a successful late read, without starting further I/O", async ({ index }) => {
  const { capture, calls } = fixture(index);
  const late = new Error("late deadline"), complete = new Error("complete deadline");
  let partial: LinuxPartialObservation | undefined;
  let completed: unknown;
  const result = await capture(pid, 100, state => { completed = state; return complete; }, (error, observed) => {
    partial = { ...observed };
    return error;
  }, () => late).catch(error => error);

  expect(result).toBe(index === stages.length - 1 ? complete : late);
  expect(calls).toEqual(paths.slice(0, index + 1));
  expect(Object.keys(partial!)).toEqual(stages.slice(0, index + 1));
  expect(partial!.boot).toBe(boot);
  if (index >= 1) expect(partial!.stat).toMatchObject({ parent, group: pid, ticks: "26140755" });
  if (index >= 2) expect(partial!.first).toMatchObject({ parent, group: pid, command: "node worker.js" });
  if (index >= 3) expect(partial!.second).toMatchObject({ parent, group: pid, command: "node worker.js" });
  if (index >= 4) expect(partial!.after).toMatchObject({ parent, group: pid, ticks: "26140755" });
  if (index >= 5) {
    expect(partial!.afterBoot).toBe(boot);
    expect(completed).toMatchObject({ proof: { pid, parentPid: parent, processGroupId: pid, startedAt: `linux:v1:${boot}:26140755`, commandHash: "hash:node worker.js" } });
  } else expect(completed).toBeUndefined();
});

it.each(stages.map((stage, index) => ({ stage, index })))("preserves malformed $stage returned at the deadline", async ({ index }) => {
  const { capture, calls } = fixture(index, true);
  const late = new Error("late deadline"), complete = new Error("complete deadline");
  let partial: LinuxPartialObservation | undefined;
  const error = await capture(pid, 100, () => complete, (cause, observed) => {
    partial = { ...observed };
    return cause;
  }, () => late).catch(cause => cause);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBe(late);
  expect(error).not.toBe(complete);
  expect(error.message).toMatch(index === 0 || index === 5 ? /boot identity/ : index === 1 || index === 4 ? /process stat/ : /command identity/);
  expect(calls).toEqual(paths.slice(0, index + 1));
  expect(Object.keys(partial!)).toEqual(stages.slice(0, index));
});

it("rejects a large malformed late ps response without backtracking over its whitespace", async () => {
  let time = 0;
  const capture = createLinuxProcessCapture(
    async path => path.endsWith("boot_id") ? boot : stat,
    async () => { time = 100; return `${ps.trim()}${" ".repeat(100_000)}\nextra`; },
    value => value,
    () => time,
  );
  await expect(capture(pid, 100, undefined, undefined, () => new Error("deadline"))).rejects.toThrow("Linux process command identity cannot be established.");
}, 5_000);
