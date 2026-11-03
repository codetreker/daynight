import { readFileSync } from "node:fs";

export const sessionV2FixtureRoot = new URL("./fixtures/v2/", import.meta.url);
export const sessionV2Fixture = (name: string): any => JSON.parse(readFileSync(new URL(`${name}.json`, sessionV2FixtureRoot), "utf8"));
