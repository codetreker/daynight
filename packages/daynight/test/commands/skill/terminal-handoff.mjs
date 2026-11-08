import { pathToFileURL } from "node:url";

const { createTerminalPrompt } = await import(pathToFileURL(process.argv[2]).href);
const prompt = createTerminalPrompt();
const signal = new AbortController().signal;
try {
  const first = await prompt.ask("First input: ", signal);
  const choice = await prompt.select({ message: "Choose a value?", choices: [{ name: "One", value: "one" }, { name: "Two", value: "two" }], default: "one" }, signal);
  const last = await prompt.ask("Last input: ", signal);
  process.stdout.write(JSON.stringify({ first, choice, last }));
} finally {
  prompt.close();
}
