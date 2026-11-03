import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachPullRefresh } from '../web/src/pull-refresh.js';

function harness() {
  const handlers = new Map(), phases = [];
  const state = { top: true, enabled: true, count: 0, resolve: null };
  const target = { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) };
  const dispose = attachPullRefresh({ target, atTop: () => state.top, enabled: () => state.enabled,
    refresh: () => { state.count++; return new Promise(resolve => { state.resolve = resolve; }); },
    onState: (phase, distance) => phases.push({ phase, distance }) });
  const touch = (type, x, y, count = 1) => {
    const event = { target: { closest: () => null }, touches: Array.from({ length: count }, () => ({ clientX: x, clientY: y })), cancelable: true, preventDefault() { this.prevented = true; } };
    const result = handlers.get(type)?.(event);
    return { event, result };
  };
  return { state, phases, touch, dispose, handlers };
}
test('a downward pull at the top arms and refreshes exactly once on release', async () => {
  const h = harness();
  h.touch('touchstart', 20, 100);
  assert.equal(h.touch('touchmove', 20, 250).event.prevented, true);
  assert.equal(h.phases.at(-1).phase, 'armed');
  const end = h.touch('touchend', 20, 250).result;
  assert.equal(h.state.count, 1);
  assert.equal(h.phases.at(-1).phase, 'refreshing');
  h.touch('touchstart', 20, 100); h.touch('touchmove', 20, 300); await h.touch('touchend').result;
  assert.equal(h.state.count, 1);
  h.state.resolve(); await end;
  assert.equal(h.phases.at(-1).phase, 'idle');
  h.dispose(); assert.equal(h.handlers.size, 0);
});
test('short, horizontal, cancelled, scrolled and disabled gestures do not refresh', async () => {
  for (const scenario of ['short', 'horizontal', 'cancelled', 'scrolled', 'disabled', 'multitouch']) {
    const h = harness();
    if (scenario === 'scrolled') h.state.top = false;
    if (scenario === 'disabled') h.state.enabled = false;
    h.touch('touchstart', 20, 100);
    h.touch('touchmove', scenario === 'horizontal' ? 300 : 20, scenario === 'short' ? 130 : 250, scenario === 'multitouch' ? 2 : 1);
    if (scenario === 'cancelled') h.touch('touchcancel');
    await h.touch('touchend').result;
    assert.equal(h.state.count, 0, scenario);
  }
});
