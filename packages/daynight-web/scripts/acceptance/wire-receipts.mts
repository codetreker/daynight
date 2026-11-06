export type WireReceipt = {
  readonly requestId: string;
  readonly path: string;
  readonly validator: boolean;
  readonly wireStatus: number | null;
  readonly wireBytes: number | null;
};
type Headers = Readonly<Record<string, unknown>>;
type RequestEvent = { readonly requestId: string; readonly request: { readonly url: string; readonly headers: Headers } };
type RequestExtraEvent = { readonly requestId: string; readonly headers: Headers };
type ResponseExtraEvent = { readonly requestId: string; readonly statusCode: number };
type FinishedEvent = { readonly requestId: string; readonly encodedDataLength: number };
type PendingReceipt = {
  path: string | null;
  validator: boolean;
  hasRequestExtra: boolean;
  wireStatus: number | null;
  wireBytes: number | null;
};
const hasValidator = (headers: Headers): boolean => Object.keys(headers).some((name) => name.toLowerCase() === 'if-none-match');

export const createWireReceipts = (paths: readonly string[]) => {
  const tracked = new Set(paths);
  const pending = new Map<string, PendingReceipt>();
  // Chromium delivers the request lifecycle and extra information on independent channels.
  // https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/playwright-core/src/server/chromium/crNetworkManager.ts#L779-L788
  const receipt = (requestId: string): PendingReceipt => {
    let value = pending.get(requestId);
    if (value === undefined) {
      value = { path: null, validator: false, hasRequestExtra: false, wireStatus: null, wireBytes: null };
      pending.set(requestId, value);
    }
    return value;
  };
  return {
    requestWillBeSent: (event: RequestEvent): void => {
      const value = receipt(event.requestId);
      const path = new URL(event.request.url).pathname;
      value.path = tracked.has(path) ? path : null;
      if (!value.hasRequestExtra) value.validator = hasValidator(event.request.headers);
    },
    requestWillBeSentExtraInfo: (event: RequestExtraEvent): void => {
      const value = receipt(event.requestId);
      value.validator = hasValidator(event.headers);
      value.hasRequestExtra = true;
    },
    responseReceivedExtraInfo: (event: ResponseExtraEvent): void => { receipt(event.requestId).wireStatus = event.statusCode; },
    loadingFinished: (event: FinishedEvent): void => { receipt(event.requestId).wireBytes = event.encodedDataLength; },
    receipts: (): readonly WireReceipt[] => [...pending].flatMap(([requestId, value]) => value.path === null ? [] : [{
      requestId, path: value.path, validator: value.validator, wireStatus: value.wireStatus, wireBytes: value.wireBytes,
    }]),
  };
};
