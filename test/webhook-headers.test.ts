/**
 * Delivery-context headers (Req 35.5c).
 *
 * Unit tests for `buildDeliveryHeaders`, the dispatcher's forwarding of a job's
 * headers to the delivery function, and the real HTTP client sending them on
 * the wire (checked against a local server, so the actual header bytes and the
 * body are asserted — not a mock).
 */

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildDeliveryHeaders, DELIVERY_HEADERS } from '../src/webhook/delivery-headers.js';
import { createHttpDeliveryFn } from '../src/webhook/http-delivery.js';
import { WebhookDispatcherImpl } from '../src/webhook/webhook-dispatcher.js';

const base = {
  subscriptionId: 'sub-abc-0001',
  documentType: 'orders',
  dId: { type: 'single' as const, value: 'ORD-1001' },
  enqueuedAt: '2026-11-01T12:00:00.000Z',
  dIdDelimiter: ':',
};

describe('buildDeliveryHeaders', () => {
  it('emits the four always-present headers for a whole-document subscription', () => {
    expect(buildDeliveryHeaders(base)).toEqual({
      'TamaDB-Subscription-Id': 'sub-abc-0001',
      'TamaDB-Document-Type': 'orders',
      'TamaDB-D-Id': 'ORD-1001',
      'TamaDB-Enqueued-At': '2026-11-01T12:00:00.000Z',
    });
  });

  it('adds TamaDB-Path only for a node-scoped subscription', () => {
    expect('TamaDB-Path' in buildDeliveryHeaders(base)).toBe(false);
    expect('TamaDB-Path' in buildDeliveryHeaders({ ...base, path: '' })).toBe(false);
    expect(buildDeliveryHeaders({ ...base, path: 'location.room' })['TamaDB-Path']).toBe('location.room');
  });

  it('writes a composed D-Id in URL form: parts joined by the delimiter', () => {
    const h = buildDeliveryHeaders({ ...base, dId: { type: 'composed', parts: ['ORD-1001', 'L-1'] } });
    expect(h['TamaDB-D-Id']).toBe('ORD-1001:L-1');
  });

  it('percent-encodes parts so a delimiter or slash inside a value survives', () => {
    const h = buildDeliveryHeaders({ ...base, dId: { type: 'composed', parts: ['a:b', 'c/d'] } });
    expect(h['TamaDB-D-Id']).toBe('a%3Ab:c%2Fd');
    // The consumer reverses it exactly like a URL segment: split, then decode.
    expect(h['TamaDB-D-Id']?.split(':').map(decodeURIComponent)).toEqual(['a:b', 'c/d']);
  });

  it('keeps header values header-safe: no raw spaces, non-ASCII or newlines', () => {
    const h = buildDeliveryHeaders({ ...base, documentType: 'Zürich orders\nX', path: 'a b.ç' });
    for (const v of Object.values(h)) expect(v).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeURIComponent(h['TamaDB-Document-Type']!)).toBe('Zürich orders\nX');
    expect(decodeURIComponent(h['TamaDB-Path']!)).toBe('a b.ç');
  });

  it('exposes the header names in one place', () => {
    expect(Object.values(DELIVERY_HEADERS).sort()).toEqual([
      'TamaDB-D-Id',
      'TamaDB-Document-Type',
      'TamaDB-Enqueued-At',
      'TamaDB-Path',
      'TamaDB-Subscription-Id',
    ]);
  });
});

describe('dispatcher forwards the job headers to the delivery function', () => {
  it('passes job.headers as the third argument', async () => {
    const dispatcher = new WebhookDispatcherImpl();
    let seen: Readonly<Record<string, string>> | undefined;
    dispatcher.setDeliveryFn(async (_url, _payload, headers) => {
      seen = headers;
      return { success: true, statusCode: 200 };
    });
    dispatcher.enqueue({
      subscriptionId: 'sub-1',
      dId: base.dId,
      documentType: 'orders',
      payload: { a: 1 },
      callbackUrl: 'https://sink/x',
      enqueuedAt: base.enqueuedAt,
      deliveryMode: 'fire-and-forget',
      headers: { 'TamaDB-D-Id': 'ORD-1001' },
    });
    await dispatcher.processNext();
    expect(seen).toEqual({ 'TamaDB-D-Id': 'ORD-1001' });
  });

  it('a job enqueued without headers still delivers (headers undefined)', async () => {
    const dispatcher = new WebhookDispatcherImpl();
    let called = false;
    let seen: unknown = 'unset';
    dispatcher.setDeliveryFn(async (_url, _payload, headers) => {
      called = true;
      seen = headers;
      return { success: true, statusCode: 200 };
    });
    dispatcher.enqueue({
      subscriptionId: 'sub-1',
      dId: base.dId,
      documentType: 'orders',
      payload: {},
      callbackUrl: 'https://sink/x',
      enqueuedAt: base.enqueuedAt,
      deliveryMode: 'fire-and-forget',
    });
    await dispatcher.processNext();
    expect(called).toBe(true);
    expect(seen).toBeUndefined();
  });
});

describe('createHttpDeliveryFn sends the headers and the bare body on the wire', () => {
  /** Start a throwaway local server that records the request and answers `status`. */
  async function withServer<T>(
    status: number,
    run: (url: string, got: { headers: http.IncomingHttpHeaders; body: string }) => Promise<T>,
  ): Promise<T> {
    const got = { headers: {} as http.IncomingHttpHeaders, body: '' };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.headers = req.headers;
        got.body = body;
        res.writeHead(status);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      return await run(`http://127.0.0.1:${port}/hook`, got);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('delivers TamaDB-* headers and the JSON body, with a JSON content type', async () => {
    await withServer(200, async (url, got) => {
      const deliver = createHttpDeliveryFn(5000);
      const ctx = buildDeliveryHeaders({ ...base, path: 'temperature' });
      const result = await deliver(url, { temperature: 22 }, ctx);

      expect(result).toEqual({ success: true, statusCode: 200 });
      expect(got.body).toBe('{"temperature":22}'); // the bare payload, nothing else
      expect(got.headers['content-type']).toBe('application/json');
      expect(got.headers['tamadb-subscription-id']).toBe('sub-abc-0001');
      expect(got.headers['tamadb-document-type']).toBe('orders');
      expect(got.headers['tamadb-d-id']).toBe('ORD-1001');
      expect(got.headers['tamadb-path']).toBe('temperature');
      expect(got.headers['tamadb-enqueued-at']).toBe('2026-11-01T12:00:00.000Z');
    });
  });

  it('the content type cannot be overridden by a supplied header', async () => {
    await withServer(200, async (url, got) => {
      await createHttpDeliveryFn(5000)(url, {}, { 'content-type': 'text/plain' });
      expect(got.headers['content-type']).toBe('application/json');
    });
  });

  it('still works with no headers at all', async () => {
    await withServer(200, async (url, got) => {
      const result = await createHttpDeliveryFn(5000)(url, { a: 1 });
      expect(result.success).toBe(true);
      expect(got.body).toBe('{"a":1}');
    });
  });

  it('reports a non-2xx response as a failed attempt', async () => {
    await withServer(500, async (url) => {
      const result = await createHttpDeliveryFn(5000)(url, {}, { 'TamaDB-D-Id': 'x' });
      expect(result).toMatchObject({ success: false, statusCode: 500 });
    });
  });
});
