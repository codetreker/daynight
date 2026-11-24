export const prepareCompatBrowserScope = async (input: {
  signal: AbortSignal;
  begin(): Promise<string>;
  cancel(id: string): Promise<void>;
  submit(id: string): Promise<void>;
}): Promise<string> => {
  const scope = await input.begin();
  if (input.signal.aborted) {
    await input.cancel(scope);
    input.signal.throwIfAborted();
  }
  await input.submit(scope);
  input.signal.throwIfAborted();
  return scope;
};
