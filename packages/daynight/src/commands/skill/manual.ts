export const validateManualContents = (contents: Uint8Array): void => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
  if (/^[\s\p{White_Space}]*$/u.test(text)) throw new Error("Daynight CLI manual must not be empty or whitespace.");
};
