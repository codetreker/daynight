import { expect, test } from "vitest";
import { controllerDecoderAdmission } from "../../../src/commands/controller/media/decoder-admission.js";

test("decoder admission keeps FIFO order, bounds waiting metadata and reuses a cancelled waiting slot", async () => {
  const admission = controllerDecoderAdmission(), active = new AbortController();
  const release = await admission.acquire(active.signal);
  const controllers = Array.from({ length: 32 }, () => new AbortController());
  const order: number[] = [];
  const work = controllers.map((controller, index) => admission.acquire(controller.signal).then(done => { order.push(index); return done; }));
  expect(() => admission.acquire(new AbortController().signal)).toThrow("queue capacity");
  const cancelled = new Error("Waiting source was cancelled");
  const cancellation = expect(work[7]).rejects.toBe(cancelled);
  controllers[7]!.abort(cancelled); await cancellation;
  const last = admission.acquire(new AbortController().signal).then(done => { order.push(32); return done; });
  // Aborting active work cannot return capacity before its actual decoder exits.
  active.abort(new Error("Decoder is stopping"));
  await Promise.resolve(); expect(order).toEqual([]);
  release(); release();
  for (const [index, pending] of work.entries()) if (index !== 7) (await pending)();
  (await last)();
  expect(order).toEqual(Array.from({ length: 33 }, (_, index) => index).filter(index => index !== 7));
  (await admission.acquire(new AbortController().signal))();
});

test("decoder admission refuses an already cancelled descriptor without taking a slot", async () => {
  const admission = controllerDecoderAdmission(), controller = new AbortController(), reason = new Error("Stopped before admission");
  controller.abort(reason);
  expect(() => admission.acquire(controller.signal)).toThrow(reason);
  (await admission.acquire(new AbortController().signal))();
});
