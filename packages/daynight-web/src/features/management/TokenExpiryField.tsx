import { useId } from "react";
import { useI18n } from "../../i18n/LocaleProvider";

export type TokenExpiryDraft = {
  readonly mode: "never" | "custom";
  readonly input: string;
  readonly originalValue: string | null;
  readonly originalInput: string;
};

const localInput = (date: Date): string => {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
};

export const tokenExpiryDraft = (value: string | null): TokenExpiryDraft => {
  const input = value === null ? "" : localInput(new Date(value));
  return { mode: value === null ? "never" : "custom", input, originalValue: value, originalInput: input };
};

export const parseTokenExpiryDraft = (draft: TokenExpiryDraft): string | null | undefined => {
  if (draft.mode === "never") return null;
  // An untouched local minute display retains the exact server timestamp for comparison and saving.
  if (draft.originalValue !== null && draft.input === draft.originalInput) return Date.parse(draft.originalValue) > Date.now() ? draft.originalValue : undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(draft.input)) return undefined;
  const date = new Date(draft.input);
  if (!Number.isFinite(date.valueOf()) || localInput(date) !== draft.input || date.valueOf() <= Date.now()) return undefined;
  return date.toISOString();
};

export const TokenExpiryField = ({ draft, onChange, disabled, invalid }: {
  readonly draft: TokenExpiryDraft;
  readonly onChange: (draft: TokenExpiryDraft) => void;
  readonly disabled: boolean;
  readonly invalid: boolean;
}) => {
  const id = useId();
  const { messages: { auth: { management: { account: m } } } } = useI18n();
  return <div className="field token-expiry-field"><label htmlFor={`${id}-mode`}>{m.expiryLabel}</label><select id={`${id}-mode`} value={draft.mode} disabled={disabled} onChange={(event) => onChange({ ...draft, mode: event.currentTarget.value as TokenExpiryDraft["mode"] })}>
    <option value="never">{m.neverExpires}</option><option value="custom">{m.customExpiry}</option>
  </select>{draft.mode === "custom" && <div className="token-expiry-custom"><label htmlFor={`${id}-date`}>{m.expiryDateLabel}</label><input id={`${id}-date`} type="datetime-local" value={draft.input} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={`${id}-hint`} onChange={(event) => onChange({ ...draft, input: event.currentTarget.value })} /></div>}<p className={`hint${invalid ? " error" : ""}`} id={`${id}-hint`}>{invalid ? m.invalidExpiry : m.expiryHint}</p></div>;
};
