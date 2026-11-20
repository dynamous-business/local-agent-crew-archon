import { afterAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useState, type ReactElement } from 'react';
import { invalidate, useEntity } from '../store/cache';
import { K } from '../store/keys';
import { DASHBOARD_INVALIDATION_MS, useConversationSSE, useDashboardSSE } from './sse';

class TestEventSource {
  static instances: TestEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = mock(() => {});

  constructor(readonly url: string) {
    TestEventSource.instances.push(this);
  }

  lock(locked: boolean): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'conversation_lock', locked }) });
  }

  dagNode(runId = 'run-1'): void {
    this.onmessage?.({
      data: JSON.stringify({ type: 'dag_node', runId, nodeId: 'node-1', status: 'running' }),
    });
  }
}

const dom = new Window({ url: 'http://localhost' });
const globals = {
  window: dom,
  document: dom.document,
  EventSource: TestEventSource,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(
  Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  await dom.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('unlock refetches the persisted reply and updates the subscribed chat view', async () => {
  const conversationId = 'unlock-regression';
  const key = K.messages(conversationId);
  let persisted = ['User question'];
  const loadMessages = mock(async () => [...persisted]);

  function Chat(): ReactElement {
    const [locked, setLocked] = useState(false);
    useConversationSSE(conversationId, setLocked);
    const { data } = useEntity(key, loadMessages);
    return <div data-locked={locked}>{data?.join('\n')}</div>;
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Chat />));
    expect(container.textContent).toBe('User question');
    expect(loadMessages).toHaveBeenCalledTimes(1);
    const stream = TestEventSource.instances.at(-1);
    if (!stream) throw new Error('Conversation stream was not opened');
    expect(stream.url).toBe(`/api/stream/${conversationId}`);

    await act(async () => stream.lock(true));
    expect(container.firstElementChild?.getAttribute('data-locked')).toBe('true');
    expect(loadMessages).toHaveBeenCalledTimes(1);

    persisted = [...persisted, 'Persisted assistant reply'];
    await act(async () => stream.lock(false));
    expect(loadMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('User question\nPersisted assistant reply');
    expect(container.firstElementChild?.getAttribute('data-locked')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    invalidate(key);
  }
  expect(TestEventSource.instances.at(-1)?.close).toHaveBeenCalledTimes(1);
});

test('dashboard events coalesce run-list reloads and pause while the tab is hidden', async () => {
  const key = K.runs('all');
  const loadRuns = mock(async (): Promise<string[]> => ['run']);
  const runChanged = mock(() => {});

  function Feed(): ReactElement {
    useDashboardSSE(runChanged);
    useEntity(key, loadRuns);
    return <div />;
  }

  const visibility = Object.getOwnPropertyDescriptor(dom.document, 'visibilityState');
  let hidden = false;
  Object.defineProperty(dom.document, 'visibilityState', {
    configurable: true,
    get: (): string => (hidden ? 'hidden' : 'visible'),
  });

  // No fake timers in this Bun build (`mock.timers` is absent). Capture only the
  // coalescing timer — the one armed with DASHBOARD_INVALIDATION_MS — and fire it by
  // hand, so the test never waits a real second and nothing else's timer is touched.
  const realSetTimeout = globalThis.setTimeout;
  const armed: (() => void)[] = [];
  globalThis.setTimeout = ((cb: () => void, ms?: number): ReturnType<typeof setTimeout> =>
    ms === DASHBOARD_INVALIDATION_MS
      ? (armed.push(cb), 0 as unknown as ReturnType<typeof setTimeout>)
      : realSetTimeout(cb, ms)) as typeof globalThis.setTimeout;
  const fireCoalesceWindow = async (): Promise<void> => {
    const due = armed.splice(0, armed.length);
    await act(async () => {
      for (const cb of due) cb();
    });
  };

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Feed />));
    expect(loadRuns).toHaveBeenCalledTimes(1);
    const stream = TestEventSource.instances.at(-1);
    if (!stream) throw new Error('Dashboard stream was not opened');
    expect(stream.url).toBe('/api/stream/__dashboard__');

    // A burst inside one window is one run-list reload, whatever the fan-out cost.
    await act(async () => {
      for (let i = 0; i < 20; i += 1) stream.dagNode();
    });
    // The per-run signal stays per-event: the attention watcher needs each run change.
    expect(runChanged).toHaveBeenCalledTimes(20);
    expect(armed).toHaveLength(1);
    await fireCoalesceWindow();
    expect(loadRuns).toHaveBeenCalledTimes(2);

    // Hidden: frames still mark the caches dirty, but nothing is scheduled.
    hidden = true;
    await act(async () => {
      for (let i = 0; i < 10; i += 1) stream.dagNode();
    });
    expect(armed).toHaveLength(0);
    expect(loadRuns).toHaveBeenCalledTimes(2);

    // Shown again: catch up with exactly one reload.
    hidden = false;
    await act(async () => dom.document.dispatchEvent(new dom.Event('visibilitychange')));
    expect(loadRuns).toHaveBeenCalledTimes(3);

    // The next burst is again a single reload.
    await act(async () => {
      for (let i = 0; i < 5; i += 1) stream.dagNode();
    });
    expect(armed).toHaveLength(1);
    await fireCoalesceWindow();
    expect(loadRuns).toHaveBeenCalledTimes(4);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    await act(async () => root.unmount());
    container.remove();
    invalidate(key);
    if (visibility) Object.defineProperty(dom.document, 'visibilityState', visibility);
    else Reflect.deleteProperty(dom.document, 'visibilityState');
  }
  expect(TestEventSource.instances.at(-1)?.close).toHaveBeenCalledTimes(1);
});
