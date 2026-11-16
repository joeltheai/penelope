export const DEFAULT_DOC_W = 2000;
export const DEFAULT_DOC_H = 2000;
export const MIN_DOC_SIZE = 64;
export const MAX_DOC_SIZE = 8192;

export const MAX_STAMPS_PER_FLUSH = 4096;
export const FLOATS_PER_VERT = 7;
export const VERTS_PER_STAMP = 6;
export const MAX_VERT_FLOATS = MAX_STAMPS_PER_FLUSH * VERTS_PER_STAMP * FLOATS_PER_VERT;

export const GRID_BG = [0.035, 0.028, 0.075] as const;
export const GRID_LINE = [0.08, 0.095, 0.18] as const;
export const GRID_MAJOR = [0.14, 0.19, 0.34] as const;
export const GRID_SPACING = 16;
export const GRID_MAJOR_EVERY = 4;
export const MAX_PRESENT_DPR = 2;

export function sanitizeDocSize(n: number): number {
	const v = Math.round(Number.isFinite(n) ? n : DEFAULT_DOC_W);
	return Math.min(MAX_DOC_SIZE, Math.max(MIN_DOC_SIZE, v));
}
