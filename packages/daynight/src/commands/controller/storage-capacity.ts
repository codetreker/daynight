import type Database from "better-sqlite3";
import { controllerMetadataBudget, ControllerMetadataBudgetError } from "./media/metadata-budget.js";

export const isControllerStorageCapacityError = (error: unknown): error is ControllerMetadataBudgetError => error instanceof ControllerMetadataBudgetError;

export const assertControllerStorageCapacity = (file: string, db: Database.Database, additionalBytes = 0): void => {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new TypeError("Controller storage growth must be a nonnegative safe integer.");
  controllerMetadataBudget(file, db).assert(additionalBytes);
};
