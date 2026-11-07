import Database from "better-sqlite3";

export const createMemoryDatabase = (): Database.Database => new Database(":memory:");
