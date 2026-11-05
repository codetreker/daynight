import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWireReceipts } from './wire-receipts.mts';

const path = '/api/v1/me';
const requestId = 'identity-request';
const request = { requestId, request: { url: `https://acceptance.invalid${path}`, headers: { 'If-None-Match': '"profile"' } } };

test('wire receipts preserve status, validator and transfer bytes across independent CDP channel orders', () => {
  for (const [statusCode, encodedDataLength] of [[200, 235_500], [304, 278]] as const) {
    for (const order of [
      ['request', 'requestExtra', 'responseExtra', 'finished'],
      ['responseExtra', 'requestExtra', 'request', 'finished'],
      ['requestExtra', 'request', 'finished', 'responseExtra'],
      ['request', 'finished', 'responseExtra', 'requestExtra'],
    ] as const) {
      const wire = createWireReceipts([path]);
      const events = {
        request: () => wire.requestWillBeSent(request),
        requestExtra: () => wire.requestWillBeSentExtraInfo({ requestId, headers: {} }),
        responseExtra: () => wire.responseReceivedExtraInfo({ requestId, statusCode }),
        finished: () => wire.loadingFinished({ requestId, encodedDataLength }),
      };
      for (const event of order) events[event]();
      assert.deepEqual(wire.receipts(), [{ requestId, path, validator: false, wireStatus: statusCode, wireBytes: encodedDataLength }]);
    }
  }
});

test('cached validation keeps its original wire 304 and actual outgoing validator', () => {
  const wire = createWireReceipts([path]);
  wire.requestWillBeSentExtraInfo({ requestId, headers: { 'if-none-match': '"profile"' } });
  wire.responseReceivedExtraInfo({ requestId, statusCode: 304 });
  wire.requestWillBeSent({ ...request, request: { ...request.request, headers: {} } });
  wire.loadingFinished({ requestId, encodedDataLength: 0 });
  assert.deepEqual(wire.receipts(), [{ requestId, path, validator: true, wireStatus: 304, wireBytes: 0 }]);
});

test('session expiry retains early and late wire 401 headers without requiring a completed body', () => {
  for (const extraFirst of [true, false]) {
    const wire = createWireReceipts([path]);
    if (extraFirst) wire.responseReceivedExtraInfo({ requestId, statusCode: 401 });
    wire.requestWillBeSent(request);
    if (!extraFirst) wire.responseReceivedExtraInfo({ requestId, statusCode: 401 });
    assert.deepEqual(wire.receipts(), [{ requestId, path, validator: true, wireStatus: 401, wireBytes: null }]);
  }
});

test('unmatched extra information and unrelated requests are excluded from published receipts', () => {
  const wire = createWireReceipts([path, '/api/v1/projects/project/task-assignees']);
  wire.responseReceivedExtraInfo({ requestId: 'not-yet-classified', statusCode: 200 });
  wire.requestWillBeSent({ requestId: 'untracked', request: { url: 'https://acceptance.invalid/assets/main.js', headers: {} } });
  wire.responseReceivedExtraInfo({ requestId: 'untracked', statusCode: 200 });
  wire.loadingFinished({ requestId: 'untracked', encodedDataLength: 500 });
  assert.deepEqual(wire.receipts(), []);
  wire.requestWillBeSent({ ...request, requestId: 'not-yet-classified' });
  assert.equal(wire.receipts()[0]!.wireStatus, 200);
});

test('missing protocol observations remain pending without inventing status or transfer bytes', () => {
  const wire = createWireReceipts([path]);
  wire.requestWillBeSent(request);
  assert.deepEqual(wire.receipts(), [{ requestId, path, validator: true, wireStatus: null, wireBytes: null }]);
  wire.responseReceivedExtraInfo({ requestId, statusCode: 200 });
  assert.equal(wire.receipts()[0]!.wireBytes, null);
});
