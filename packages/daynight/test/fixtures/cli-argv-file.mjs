import { readFile } from "node:fs/promises";

if (process.argv.length !== 3) throw new Error("Expected the CLI entry and one argument file.");
const args = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) throw new Error("CLI argument file must contain only an array of strings.");
process.argv.splice(2, 1, ...args);
