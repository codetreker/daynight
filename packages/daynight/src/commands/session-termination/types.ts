import type { WebTerminationClosure } from "../worker/backends/web-termination.js";
import type { HerdrTerminationClosure } from "../worker/herdr/termination-closure.js";

/** Complete original Session execution evidence, independent of recording contents. */
export type SessionTerminationClosure = WebTerminationClosure | HerdrTerminationClosure;
