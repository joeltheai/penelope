export const DEFAULT_DOC_W = 2000;
export const DEFAULT_DOC_H = 2000;
export const MIN_DOC_SIZE = 64;
export const MAX_DOC_SIZE = 8192;
export const BRUSH_SIZE = 128;

export const MAX_STAMPS_PER_FLUSH = 4096;
export const FLOATS_PER_VERT = 7;
export const VERTS_PER_STAMP = 6;
export const MAX_VERT_FLOATS = MAX_STAMPS_PER_FLUSH * VERTS_PER_STAMP * FLOATS_PER_VERT;

/**
 * Per-dab airbrush flow. Repeated dabs approach the pressure opacity cap,
 * matching Krita's non-incremental Alpha Darken wash behavior.
 */
export const AIRBRUSH_FLOW = 0.12;

export const GRID_BG = [0.11, 0.11, 0.114] as const;
export const GRID_LINE = [0.18, 0.18, 0.185] as const;
export const GRID_MAJOR = [0.24, 0.24, 0.25] as const;
// CSS pixels between minor lines — smaller = denser
export const GRID_SPACING = 16;
export const GRID_MAJOR_EVERY = 4;
/** Cap backing-store DPR to keep present fillrate cheap. */
export const MAX_PRESENT_DPR = 2;

/** Clamp document dimension to a safe GPU texture size. */
export function sanitizeDocSize(n: number): number {
	const v = Math.round(Number.isFinite(n) ? n : DEFAULT_DOC_W);
	return Math.min(MAX_DOC_SIZE, Math.max(MIN_DOC_SIZE, v));
}
