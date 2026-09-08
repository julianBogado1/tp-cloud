import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IngestedReading } from '@snowball/shared';

// src/api.ts computes `API_BASE` from `window.location.origin` at
// module-evaluation time (there is no VITE_API_BASE in this test run), so
// `window` must exist before the import below runs. vi.hoisted lifts this
// above the (hoisted) import statements, the same trick vi.mock relies on.
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    location: { origin: 'http://localhost:5173' },
  };
});

import { connectLive, setUnauthorizedHandler } from '../src/api';
import { getSession, setSession } from '../src/auth';

/** Minimal in-memory Storage stand-in for sessionStorage (auth.ts's only DOM dependency). */
class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

/** Fake WebSocket driven manually by tests: no real network, no real timers. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closeCalls += 1;
  }
}

/** A structurally valid (but unsigned) JWT with a far-future `exp`, so getSession() treats it as live. */
function fakeToken(): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: 9_999_999_999 })}.sig`;
}

function fakeSession() {
  return { token: fakeToken(), user: { id: 1, email: 'a@b.com', role: 'operator' as const, client_id: 1 } };
}

function fakeReading(): IngestedReading {
  return { unit_id: 'SB-001', ts: '2026-09-07T00:00:00Z', temp_c: -18 };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('sessionStorage', new FakeStorage());
  vi.stubGlobal('WebSocket', FakeWebSocket);
  FakeWebSocket.instances = [];
  setUnauthorizedHandler(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setUnauthorizedHandler(() => undefined);
});

describe('connectLive', () => {
  test('sends subscribe only after receiving { type: "ready" }, not before', () => {
    const onReading = vi.fn();
    const onStatus = vi.fn();
    connectLive(['SB-001', 'SB-002'], 'tok', onReading, onStatus);

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toContain('token=tok');

    socket.onopen?.();
    expect(onStatus).toHaveBeenCalledWith(true);
    expect(socket.sent).toHaveLength(0);

    // A reading that arrives before 'ready' must not trigger a subscribe.
    socket.onmessage?.({ data: JSON.stringify({ type: 'reading', data: fakeReading() }) });
    expect(socket.sent).toHaveLength(0);
    expect(onReading).toHaveBeenCalledWith(fakeReading());

    socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) });
    expect(socket.sent).toEqual([JSON.stringify({ subscribe: ['SB-001', 'SB-002'] })]);
  });

  test('a 4401 close clears the session, notifies unauthorized, and schedules no retry', () => {
    setSession(fakeSession());
    expect(getSession()).not.toBeNull();

    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    connectLive(['SB-001'], 'tok', vi.fn(), vi.fn());

    const socket = FakeWebSocket.instances[0];
    socket.onclose?.({ code: 4401 });

    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(getSession()).toBeNull();

    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // no reconnect attempt
  });

  test('a close with any other code schedules a retry after 3s', () => {
    connectLive(['SB-001'], 'tok', vi.fn(), vi.fn());
    const first = FakeWebSocket.instances[0];

    first.onclose?.({ code: 1006 });
    expect(FakeWebSocket.instances).toHaveLength(1); // not yet

    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances).toHaveLength(2); // reconnected
  });

  test('the returned cleanup function prevents any further reconnect', () => {
    const cleanup = connectLive(['SB-001'], 'tok', vi.fn(), vi.fn());
    const first = FakeWebSocket.instances[0];

    first.onclose?.({ code: 1006 }); // schedules a retry timer
    cleanup();

    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1); // the pending retry timer was cleared
    expect(first.closeCalls).toBeGreaterThan(0); // cleanup also closes the live socket
  });
});
