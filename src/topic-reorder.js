import { moveTopic, topicFor } from './topics.js';

// Pointer capture keeps touch and mouse drags on the handle without hijacking row scrolling.
export function attachTopicReorder({ list, save, announce }) {
  const dialog = list.closest('dialog'), controller = new AbortController();
  let drag = null, frame = 0;
  const rows = () => [...list.querySelectorAll('.topic-row')];
  const order = () => rows().map(row => row.dataset.topicId);
  const position = () => `${topicFor(drag.id).label}, position ${order().indexOf(drag.id) + 1} of ${rows().length}.`;
  function begin(handle, pointer = null) {
    const row = handle.closest('.topic-row');
    drag = { handle, row, id: row.dataset.topicId, original: order(), pointer,
      started: pointer === null, y: pointer?.clientY, startY: pointer?.clientY,
      offset: pointer ? pointer.clientY - row.getBoundingClientRect().top : 0 };
    handle.focus({ preventScroll: true });
    if (drag.started) lift();
  }
  function lift() {
    drag.started = true;
    list.classList.add('is-reordering');
    drag.row.classList.add('is-dragging');
    drag.handle.setAttribute('aria-pressed', 'true');
    announce(`${topicFor(drag.id).label} picked up. Use arrow keys to move, Space to save, or Escape to cancel.`);
  }
  function moveTo(index) {
    const next = moveTopic(order(), drag.id, index);
    const others = rows().filter(row => row !== drag.row);
    list.insertBefore(drag.row, others[next.indexOf(drag.id)] || null);
  }
  function followPointer() {
    const others = rows().filter(row => row !== drag.row);
    const index = others.findIndex(row => {
      const box = row.getBoundingClientRect();
      return drag.y < box.top + box.height / 2;
    });
    moveTo(index < 0 ? others.length : index);
    drag.row.style.transform = '';
    const top = drag.row.getBoundingClientRect().top;
    drag.row.style.transform = `translateY(${drag.y - drag.offset - top}px)`;
  }
  function autoScroll() {
    if (!drag?.pointer || !drag.started) return;
    const box = dialog.getBoundingClientRect();
    const top = box.top + dialog.querySelector('.sheet-header').offsetHeight;
    const speed = drag.y > box.bottom - 48 ? Math.min(18, (drag.y - box.bottom + 48) / 3) :
      drag.y < top + 48 ? -Math.min(18, (top + 48 - drag.y) / 3) : 0;
    if (speed) { dialog.scrollTop += speed; followPointer(); }
    frame = requestAnimationFrame(autoScroll);
  }
  function finish(commit) {
    if (!drag) return;
    cancelAnimationFrame(frame);
    const current = drag, next = order();
    const changed = next.some((id, index) => id !== current.original[index]);
    // Clear before releasing capture: lostpointercapture must not cancel a saved drop.
    drag = null;
    if (current.pointer && list.hasPointerCapture(current.pointer.pointerId)) list.releasePointerCapture(current.pointer.pointerId);
    current.row.style.transform = '';
    current.row.classList.remove('is-dragging');
    current.handle.setAttribute('aria-pressed', 'false');
    list.classList.remove('is-reordering');
    const saved = commit && changed ? save(next) : commit;
    if (!saved) for (const id of current.original) list.append(rows().find(row => row.dataset.topicId === id));
    current.handle.focus({ preventScroll: true });
    if (current.started) announce(saved ? `${topicFor(current.id).label} placed at position ${next.indexOf(current.id) + 1}.` :
      commit && changed ? 'Could not save topic order. Previous order restored.' : 'Reorder canceled. Topic order unchanged.');
  }
  const listen = (type, callback) => list.addEventListener(type, callback, { signal: controller.signal });
  listen('pointerdown', event => {
    const handle = event.target.closest('.topic-reorder');
    if (!handle || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    if (drag) finish(false);
    begin(handle, event);
    list.setPointerCapture(event.pointerId);
  });
  listen('pointermove', event => {
    if (!drag?.pointer || drag.pointer.pointerId !== event.pointerId) return;
    drag.y = event.clientY;
    if (!drag.started && Math.abs(drag.y - drag.startY) < 4) return;
    if (!drag.started) { lift(); frame = requestAnimationFrame(autoScroll); }
    followPointer();
  });
  listen('pointerup', event => {
    if (drag?.pointer?.pointerId === event.pointerId) finish(true);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) listen(type, event => {
    if (drag?.pointer?.pointerId === event.pointerId) finish(false);
  });
  listen('keydown', event => {
    const handle = event.target.closest('.topic-reorder');
    if (!handle) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      if (drag) finish(true); else begin(handle);
    } else if (drag && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); finish(false);
    } else if (drag && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const index = order().indexOf(drag.id);
      moveTo(event.key === 'Home' ? 0 : event.key === 'End' ? rows().length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1));
      drag.handle.focus({ preventScroll: true });
      drag.row.scrollIntoView({ block: 'nearest' });
      announce(position());
    } else if (drag && event.key === 'Tab') finish(false);
  });
  dialog.addEventListener('close', () => { finish(false); controller.abort(); }, { once: true });
}
