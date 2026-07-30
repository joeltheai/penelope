/** A single stylus/finger/mouse sample for stroke building. */
export type PointerSample = {
  x: number;
  y: number;
  /** Normalized pressure in [0, 1]. Mouse reports 0.5 while down. */
  pressure: number;
  tiltX: number;
  tiltY: number;
  pointerType: PointerEvent["pointerType"];
  pointerId: number;
  timeStamp: number;
};

export type StrokeHandlers = {
  onStrokeStart?: (sample: PointerSample) => void;
  onStrokeMove?: (samples: PointerSample[]) => void;
  onStrokeEnd?: (sample: PointerSample) => void;
};

function toSample(event: PointerEvent, canvas: HTMLCanvasElement): PointerSample {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;

  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
    // Some browsers report 0 for mouse; treat active mouse as mid pressure.
    pressure:
      event.pointerType === "mouse" && event.pressure === 0
        ? 0.5
        : Math.max(0.01, event.pressure),
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    pointerType: event.pointerType,
    pointerId: event.pointerId,
    timeStamp: event.timeStamp,
  };
}

/**
 * Wire Pointer Events for drawing. Uses setPointerCapture + getCoalescedEvents
 * so Apple Pencil's ~240 Hz samples aren't collapsed to one per animation frame.
 */
export function attachPointerInput(
  canvas: HTMLCanvasElement,
  handlers: StrokeHandlers,
): () => void {
  let activePointerId: number | null = null;

  const onPointerDown = (event: PointerEvent) => {
    // Ignore secondary buttons / palm when a stroke is already active.
    if (activePointerId !== null) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;

    activePointerId = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    handlers.onStrokeStart?.(toSample(event, canvas));
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;

    // Prefer coalesced samples (high-frequency stylus). Fall back to the event itself.
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const events = coalesced.length > 0 ? coalesced : [event];
    handlers.onStrokeMove?.(events.map((e) => toSample(e, canvas)));
  };

  const endStroke = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    handlers.onStrokeEnd?.(toSample(event, canvas));
    activePointerId = null;
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", onPointerCancel);
  // Prevent context menu / long-press on stylus/touch.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", endStroke);
    canvas.removeEventListener("pointercancel", onPointerCancel);
  };
}
