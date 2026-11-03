export function attachPullRefresh({ target, atTop, enabled, refresh, onState, threshold = 64 }) {
  let start = null, distance = 0, refreshing = false;
  function clear() { start = null; distance = 0; if (!refreshing) onState('idle', 0); }
  function begin(event) {
    if (refreshing || !enabled() || !atTop() || event.touches.length !== 1 ||
        event.target.closest?.('input,textarea,dialog,.post-menu')) return;
    start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }
  function move(event) {
    if (!start || !enabled() || event.touches.length !== 1) { clear(); return; }
    const point = event.touches[0], dy = point.clientY - start.y, dx = point.clientX - start.x;
    if (!atTop() || dy < 0 || Math.abs(dx) > Math.abs(dy)) { clear(); return; }
    if (dy < 8) return;
    if (event.cancelable) event.preventDefault();
    distance = Math.min(threshold + 25, dy * .5);
    onState(distance >= threshold ? 'armed' : 'pulling', distance);
  }
  async function end() {
    const armed = start && distance >= threshold && enabled() && atTop();
    start = null; distance = 0;
    if (!armed) { clear(); return; }
    refreshing = true; onState('refreshing', threshold);
    try { await refresh(); }
    finally { refreshing = false; onState('idle', 0); }
  }
  target.addEventListener('touchstart', begin, { passive: true });
  target.addEventListener('touchmove', move, { passive: false });
  target.addEventListener('touchend', end);
  target.addEventListener('touchcancel', clear);
  return () => {
    target.removeEventListener('touchstart', begin); target.removeEventListener('touchmove', move);
    target.removeEventListener('touchend', end); target.removeEventListener('touchcancel', clear);
  };
}
