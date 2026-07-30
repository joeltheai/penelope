/** Resize the canvas drawing buffer to match CSS size × devicePixelRatio. */
export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): boolean {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  // Round (not floor) so buffer size stays closer to CSS × dpr and scaleX/Y
  // don't drift — fractional CSS sizes are common in portrait flex layouts.
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

  if (canvas.width === width && canvas.height === height) {
    return false;
  }

  canvas.width = width;
  canvas.height = height;
  return true;
}

export function clearCanvas(
  ctx: CanvasRenderingContext2D,
  fill = "#f4f1ea",
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
}
