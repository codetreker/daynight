import { afterEach, expect, test } from "vitest";
import { frozenToolLaunch } from "../../helpers/tool-launch.js";
import { BotAdmissionBlockedError } from "../../../src/commands/worker/bots/process.js";
import { ControllerIpcOutcomeUnknownError } from "../../../src/commands/controller/local-client.js";
import { cleanupBotProcesses, fixture, id } from "./bot-process.fixtures.js";

afterEach(cleanupBotProcesses);

test("waits before preparation or durable intent when new execution admission is closed", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.setAdmission(false);
  await expect(f.process.advance(f.current(), signal)).rejects.toBeInstanceOf(BotAdmissionBlockedError);
  expect(f.current().intent).toBeNull();
  expect(f.prepareEnvironment).not.toHaveBeenCalled();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  f.setAdmission(true);
  await expect(f.process.advance(f.current(), signal)).resolves.toMatchObject({ lifecycle: "ready" });
  expect(f.register).toHaveBeenCalledOnce();
  expect(f.launch).toHaveBeenCalledOnce();
});

test("rechecks admission after environment preparation and releases unsubmitted aliases", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const prepare = f.prepareEnvironment.getMockImplementation()!;
  f.prepareEnvironment.mockImplementationOnce(async () => {
    const prepared = await prepare();
    f.setAdmission(false);
    return prepared;
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toBeInstanceOf(BotAdmissionBlockedError);
  expect(f.current().intent).toBeNull();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
  f.setAdmission(true);
  await f.process.advance(f.current(), signal);
  expect(f.prepareEnvironment).toHaveBeenCalledTimes(2);
  expect(f.launch).toHaveBeenCalledOnce();
});

test("rechecks admission after asynchronous tool preparation before freezing the first intent", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.selectToolLaunch.mockImplementationOnce(async agent => {
    f.setAdmission(false);
    return frozenToolLaunch(agent);
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toBeInstanceOf(BotAdmissionBlockedError);
  expect(f.current().intent).toBeNull();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledOnce();
});

test("preserves a confirmed first registration while admission closes before launch", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const register = f.register.getMockImplementation()!;
  f.register.mockImplementationOnce(async record => {
    const receipt = await register(record);
    f.setAdmission(false);
    return receipt;
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toBeInstanceOf(BotAdmissionBlockedError);
  const original = f.current().intent!;
  expect(original.sessionId).toBe(id(4));
  expect(f.executions.get(f.current())).toMatchObject({ launchSubmission: "not-submitted", lastError: null });
  expect(f.grant).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  f.setAdmission(true);
  await f.process.advance(f.current(), signal);
  expect(f.current().intent).toMatchObject({ launchId: original.launchId, sessionId: original.sessionId, executionGeneration: "1" });
  expect(f.register).toHaveBeenCalledOnce();
  expect(f.launch).toHaveBeenCalledOnce();
});

test("leaves initial launch unsubmitted when admission closes inside launch preparation", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    f.setAdmission(false);
    await options.onSubmitting();
    throw new Error("An admission-blocked launch must not reach submission.");
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toBeInstanceOf(BotAdmissionBlockedError);
  const original = f.current().intent!;
  expect(f.executions.get(f.current())).toMatchObject({ launchSubmission: "not-submitted", controllerProcess: null, lastError: null });
  expect(f.register).toHaveBeenCalledOnce();
  f.setAdmission(true);
  await f.process.advance(f.current(), signal);
  expect(f.current().intent!.launchId).toBe(original.launchId);
  expect(f.register).toHaveBeenCalledOnce();
  expect(f.launch).toHaveBeenCalledTimes(2);
});

test("reconciles a submitted unknown launch while new execution admission is closed", async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.launch.mockImplementationOnce(async options => {
    await options.onSubmitting();
    throw new Error("The original spawn result was lost.");
  });
  await expect(f.process.advance(f.current(), signal)).rejects.toThrow("The original spawn result was lost.");
  const original = f.current().intent!;
  f.setAdmission(false);
  f.observe.mockRejectedValueOnce(new ControllerIpcOutcomeUnknownError("IPC unavailable"));
  await expect(f.createProcess().advance(f.current(), signal)).rejects.toThrow(/original spawn proof|spawn proof.*unavailable/);
  await expect(f.createProcess().advance(f.current(), signal)).resolves.toMatchObject({ lifecycle: "ready", nativeSessionId: id(9) });
  expect(f.current().intent!.launchId).toBe(original.launchId);
  expect(f.launch).toHaveBeenCalledOnce();
  expect(f.register).toHaveBeenCalledOnce();
});

test("preserves wrapped local admission waiting only while initial launch is unsubmitted", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const waiting = new Error("Controller preparation forwarded its local admission guard.", { cause: new BotAdmissionBlockedError() });
  f.launch.mockImplementationOnce(async () => { f.setAdmission(false); throw waiting; });
  await expect(f.process.advance(f.current(), signal)).rejects.toMatchObject({ name: "BotAdmissionBlockedError", cause: waiting });
  expect(f.executions.get(f.current())).toMatchObject({ launchSubmission: "not-submitted", startup: null, lastError: null });
  f.setAdmission(true);
  await f.process.advance(f.current(), signal);
  expect(f.register).toHaveBeenCalledOnce();
  expect(f.launch).toHaveBeenCalledTimes(2);
});

test("keeps an environment preparation wrapper with a local admission guard waiting", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const waiting = new Error("Environment preparation forwarded its admission guard.", { cause: new BotAdmissionBlockedError() });
  f.prepareEnvironment.mockImplementationOnce(async () => { f.setAdmission(false); throw waiting; });
  await expect(f.process.advance(f.current(), signal)).rejects.toMatchObject({ name: "BotAdmissionBlockedError", cause: waiting });
  expect(f.current().intent).toBeNull();
  expect(f.register).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
});
