import { malformed, string } from "./parse";

export const parseProfileVersion = (value: unknown): string => {
  const version = string(value);
  return /^[a-f0-9]{64}$/.test(version) ? version : malformed();
};
