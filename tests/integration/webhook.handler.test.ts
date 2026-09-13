/**
 * Integration tests for the Vercel API entry point: api/webhook/gmail.ts
 *
 * processGmailNotification (src/webhook/gmail.ts) is mocked — this tests
 * only the HTTP contract of the webhook handler:
 *   - Method guard (405)
 *   - Process-then-respond: HTTP 200 is sent AFTER processing completes
 *     (Vercel freezes the function the instant its response flushes, so a
 *     "respond-first" pattern would kill any background work started after)
 *   - processGmailNotification is called with the body and token from query
 *   - Errors from processGmailNotification are caught and still ack (200)
 */

import handler from '../../api/webhook/gmail';
import * as webhookModule from '../../src/webhook/gmail';
import { mockReq, mockRes } from '../helpers/request';

jest.mock('../../src/webhook/gmail', () => ({
  processGmailNotification: jest.fn(),
}));

const mockProcess = jest.mocked(webhookModule.processGmailNotification);

const VALID_PAYLOAD = {
  message: {
    data:        Buffer.from(JSON.stringify({ emailAddress: 'test@example.com', historyId: 12345 })).toString('base64'),
    messageId:   'msg-id-001',
    publishTime: new Date().toISOString(),
  },
  subscription: 'projects/test/subscriptions/vibemail-sub',
};

beforeEach(() => {
  mockProcess.mockResolvedValue();
});

describe('POST /webhook/gmail — API entry point', () => {

  // ── Method guard ───────────────────────────────────────────────────────────

  it('405 — rejects GET requests', async () => {
    const { state, res } = mockRes();
    await handler(mockReq({ method: 'GET' }), res);
    expect(state.statusCode).toBe(405);
    expect((state.body as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('405 — rejects DELETE requests', async () => {
    const { state, res } = mockRes();
    await handler(mockReq({ method: 'DELETE' }), res);
    expect(state.statusCode).toBe(405);
  });

  // ── Process-then-respond pattern ────────────────────────────────────────────

  it('awaits processGmailNotification before sending HTTP 200 (process-then-respond)', async () => {
    // Resolve processGmailNotification only on a later tick — if the handler
    // responded before awaiting it (the old ack-first assumption), this flag
    // would still be false by the time `handler` returns.
    let processResolved = false;
    const processPending = new Promise<void>(resolve => {
      setImmediate(() => {
        processResolved = true;
        resolve();
      });
    });
    mockProcess.mockReturnValue(processPending);

    const { state, res } = mockRes();
    await handler(
      mockReq({ method: 'POST', query: { token: 'tok' }, body: VALID_PAYLOAD }),
      res,
    );

    // Handler must not resolve — and 200 must not be sent — until
    // processGmailNotification has itself resolved.
    expect(processResolved).toBe(true);
    expect(state.statusCode).toBe(200);
    expect(state.ended).toBe(true);
  });

  // ── processGmailNotification invocation ───────────────────────────────────

  it('calls processGmailNotification with the request body', async () => {
    const { res } = mockRes();
    await handler(
      mockReq({ method: 'POST', query: { token: 'secret_token' }, body: VALID_PAYLOAD }),
      res,
    );

    // handler awaits processGmailNotification before returning, so it has
    // already been called (and settled) by this point.
    expect(mockProcess).toHaveBeenCalledWith(VALID_PAYLOAD, 'secret_token');
  });

  it('passes the token query param as the second argument', async () => {
    const { res } = mockRes();
    await handler(
      mockReq({ method: 'POST', query: { token: 'my_verification_token' }, body: {} }),
      res,
    );

    expect(mockProcess).toHaveBeenCalledWith(expect.anything(), 'my_verification_token');
  });

  it('passes empty string as token when token param is absent', async () => {
    const { res } = mockRes();
    await handler(mockReq({ method: 'POST', body: {} }), res);

    expect(mockProcess).toHaveBeenCalledWith(expect.anything(), '');
  });

  it('still returns 200 even when processGmailNotification rejects', async () => {
    mockProcess.mockRejectedValue(new Error('processing blew up'));

    const { state, res } = mockRes();
    await handler(
      mockReq({ method: 'POST', query: { token: 'tok' }, body: VALID_PAYLOAD }),
      res,
    );

    // processGmailNotification rejected, but the handler's try/catch still
    // logs and falls through to a 200 ack (no infinite Pub/Sub retries).
    expect(state.statusCode).toBe(200);
    expect(state.ended).toBe(true);
  });
});
