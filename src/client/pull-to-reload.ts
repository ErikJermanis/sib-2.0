const PULL_THRESHOLD = 80;

export function enablePullToReload(reload: () => void = () => location.reload()): () => void {
  const cue = document.createElement("div");
  cue.className = "pull-to-reload-cue";
  cue.setAttribute("role", "status");
  cue.hidden = true;
  document.body.append(cue);

  let gesture: { id: number; x: number; y: number; distance: number } | null = null;
  let reloading = false;

  const reset = () => {
    gesture = null;
    cue.hidden = true;
  };

  const start = (event: TouchEvent) => {
    reset();
    if (
      reloading ||
      event.touches.length !== 1 ||
      window.scrollY > 0 ||
      (document.scrollingElement?.scrollTop ?? 0) > 0
    ) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, button, a, [contenteditable]")) return;
    const touch = event.touches[0];
    if (touch) gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, distance: 0 };
  };

  const move = (event: TouchEvent) => {
    if (!gesture) return;
    const touch = event.touches[0];
    if (
      event.touches.length !== 1 ||
      !touch ||
      touch.identifier !== gesture.id ||
      window.scrollY > 0 ||
      (document.scrollingElement?.scrollTop ?? 0) > 0
    ) {
      reset();
      return;
    }
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (dy < -10 || (Math.abs(dx) > 14 && Math.abs(dx) > dy)) {
      reset();
      return;
    }
    gesture.distance = dy;
    cue.hidden = dy < 12;
    if (!cue.hidden) {
      cue.textContent = dy >= PULL_THRESHOLD ? "Otpustite za osvježavanje" : "Povucite za osvježavanje";
    }
  };

  const end = (event: TouchEvent) => {
    if (!gesture) return;
    const id = gesture.id;
    if (![...event.changedTouches].some((touch) => touch.identifier === id)) return;
    const shouldReload = event.touches.length === 0 && gesture.distance >= PULL_THRESHOLD;
    reset();
    if (shouldReload && !reloading) {
      reloading = true;
      reload();
    }
  };

  document.addEventListener("touchstart", start, { passive: true });
  document.addEventListener("touchmove", move, { passive: true });
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });

  return () => {
    document.removeEventListener("touchstart", start);
    document.removeEventListener("touchmove", move);
    document.removeEventListener("touchend", end);
    document.removeEventListener("touchcancel", reset);
    cue.remove();
  };
}
