import { malformed, string } from './parse';

export type CredentialDescriptionUpdate = {
  readonly expectedUserId: string;
  readonly expectedDescription: string | null;
  readonly description: string | null;
};
export type CredentialDescriptionReceipt = { readonly id: string; readonly description: string | null };
export type CredentialDescriptionProblem = 'unicode' | 'multiline' | 'tooLong';

export const credentialDescriptionProblem = (value: string): CredentialDescriptionProblem | null => {
  if (!value.isWellFormed() || value.includes('\0')) return 'unicode';
  if (/[\n\r\v\f\u0085\u2028\u2029]/u.test(value)) return 'multiline';
  if ([...value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')].length > 100) return 'tooLong';
  return null;
};

export const normalizeCredentialDescription = (value: string | null): string | null => {
  if (value === null) return null;
  const text = string(value);
  if (credentialDescriptionProblem(text) !== null) return malformed();
  const normalized = text.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  return normalized === '' ? null : normalized;
};

export const parseCredentialDescription = (value: unknown): string | null => {
  if (value === null) return null;
  const text = string(value);
  if (normalizeCredentialDescription(text) !== text) return malformed();
  return text;
};
