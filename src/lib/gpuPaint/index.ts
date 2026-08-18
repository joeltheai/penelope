export {
	DEFAULT_DOC_W,
	DEFAULT_DOC_H,
	MIN_DOC_SIZE,
	MAX_DOC_SIZE,
	sanitizeDocSize
} from './constants';
export type {
	BrushKind,
	GpuPaint,
	LassoMode,
	LassoOptions,
	RasterPatch,
	RasterHistoryEntry,
	Rect,
	ViewState
} from './types';
export { DEFAULT_LASSO_OPTIONS } from './lasso';
export { createGpuPaint } from './createGpuPaint';
