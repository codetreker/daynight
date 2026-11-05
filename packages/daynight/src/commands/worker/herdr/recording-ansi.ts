import type { TerminalStyledRun } from "../../../session/v2/types.js";
import { SESSION_V2_LIMITS, SessionV2Error } from "../../../session/v2/values.js";

const palette = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];
const initial = (): Omit<TerminalStyledRun, "text"> => ({ foreground: null, background: null, bold: false, italic: false, underline: false, inverse: false });
const rgb = (r: number, g: number, b: number): string => `#${[r, g, b].map(n => n.toString(16).padStart(2, "0")).join("")}`;
const indexed = (n: number): string => {
  if (n < 16) return palette[n]!;
  if (n >= 232) return rgb(8 + (n - 232) * 10, 8 + (n - 232) * 10, 8 + (n - 232) * 10);
  const c = n - 16, level = (v: number) => v === 0 ? 0 : 55 + v * 40;
  return rgb(level(Math.floor(c / 36)), level(Math.floor(c / 6) % 6), level(c % 6));
};

/** Herdr returns independent visible rows, not a cursor-command terminal stream. */
export const normalizeHerdrAnsi = (ansi: string, width: number, height: number): TerminalStyledRun[][] => {
  const invalid = () => { throw new SessionV2Error("recording_limit"); };
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1000 || height > 1000 || !ansi.isWellFormed() || Buffer.byteLength(ansi) > 16 * 1024 * 1024) invalid();
  let style = initial();
  const rows: TerminalStyledRun[][] = [[]]; let rowBytes = 0;
  const append = (value: string): void => {
    rowBytes += Buffer.byteLength(value); if (rowBytes > SESSION_V2_LIMITS.maxRowBytes) invalid();
    const row = rows.at(-1)!, last = row.at(-1);
    if (last && last.foreground === style.foreground && last.background === style.background && last.bold === style.bold && last.italic === style.italic && last.underline === style.underline && last.inverse === style.inverse) last.text += value;
    else { if (row.length >= SESSION_V2_LIMITS.maxTextRuns) invalid(); row.push({ text: value, ...style }); }
  };
  const sgr = (raw: string): void => {
    if (!/^[0-9;]*$/.test(raw)) return;
    const values = raw.length === 0 ? [0] : raw.split(";").map(v => v === "" ? 0 : Number(v));
    for (let i = 0; i < values.length; i++) {
      const n = values[i]!;
      if (n === 0) style = initial();
      else if (n === 1) style.bold = true; else if (n === 22) style.bold = false;
      else if (n === 3) style.italic = true; else if (n === 23) style.italic = false;
      else if (n === 4) style.underline = true; else if (n === 24) style.underline = false;
      else if (n === 7) style.inverse = true; else if (n === 27) style.inverse = false;
      else if (n === 39) style.foreground = null; else if (n === 49) style.background = null;
      else if (n >= 30 && n <= 37) style.foreground = palette[n - 30]!;
      else if (n >= 90 && n <= 97) style.foreground = palette[n - 90 + 8]!;
      else if (n >= 40 && n <= 47) style.background = palette[n - 40]!;
      else if (n >= 100 && n <= 107) style.background = palette[n - 100 + 8]!;
      else if (n === 38 || n === 48) {
        const key = n === 38 ? "foreground" : "background", mode = values[++i];
        if (mode === 5) { const value = values[++i]; if (value !== undefined && value >= 0 && value <= 255) style[key] = indexed(value); }
        else if (mode === 2) { const colors = values.slice(i + 1, i + 4); i += 3; if (colors.length === 3 && colors.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) style[key] = rgb(colors[0]!, colors[1]!, colors[2]!); }
      }
    }
  };
  for (let i = 0; i < ansi.length;) {
    const point = ansi.codePointAt(i)!, character = String.fromCodePoint(point); i += character.length;
    if (character === "\x1b" || point === 0x9b || point === 0x9d || point === 0x90) {
      const kind = point === 0x9b ? "[" : point === 0x9d ? "]" : point === 0x90 ? "P" : ansi[i++];
      if (kind === "[") {
        const beginning = i; while (i < ansi.length && !/[\x40-\x7e]/.test(ansi[i]!)) i++;
        const final = ansi[i++]; if (final === "m") sgr(ansi.slice(beginning, i - 1));
      } else if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
        while (i < ansi.length) { if (ansi[i] === "\x07" || ansi[i] === "\x9c") { i++; break; } if (ansi[i] === "\x1b" && ansi[i + 1] === "\\") { i += 2; break; } i++; }
      } else if (kind !== undefined && /[\x20-\x2f]/.test(kind)) { while (i < ansi.length && /[\x20-\x2f]/.test(ansi[i]!)) i++; if (i < ansi.length) i++; }
      continue;
    }
    if (character === "\n") { if (rows.length === height && i === ansi.length) continue; if (rows.length >= height) invalid(); rows.push([]); rowBytes = 0; continue; }
    // Visible snapshots already contain positioned printable cells. No remaining
    // control byte is allowed to acquire terminal or browser semantics.
    if (/\p{Cc}/u.test(character)) continue;
    append(character);
  }
  while (rows.length < height) rows.push([]);
  return rows;
};
