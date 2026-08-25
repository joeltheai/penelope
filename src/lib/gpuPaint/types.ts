/** Camera + present (inverse screen→doc map). */
export type ViewState = {
	x: number;
	y: number;
	zoom: number;
	rotation: number;
	/** View-only mirror: 1 = normal, -1 = flip across vertical axis. */
	flipX: number;
};

/** Stamp brushes vs path tools. */
export type BrushKind = 'pen' | 'airbrush' | 'lasso' | 'fan' | 'fanFade';

export type Rect = { x: number; y: number; w: number; h: number };

/** Exact dirty-rectangle pixels before and after a committed stroke. */
export type RasterPatch = {
	bounds: Rect;
	before: Uint8Array;
	after: Uint8Array;
};

/** One committed stroke, split into non-overlapping dirty regions. */
export type RasterHistoryEntry = RasterPatch[];

export type LassoMode = 'fill' | 'pull';

export type LassoOptions = {
	mode: LassoMode;
	/** Jagged / irregular path (fill) or spikier blobs (pull). */
	splat: boolean;
};

export type GpuPaint = {
	docW: number;
	docH: number;
	resize: (cssW: number, cssH: number) => void;
	/**
	 * Change the document pixel size (Krita `resizeImage(newRect)`).
	 * `cropX`/`cropY` are newRect.topLeft() in old document space.
	 * Pixels are translated — never scaled. New areas are white.
	 */
	resizeDocument: (
		width: number,
		height: number,
		opts?: { cropX?: number; cropY?: number }
	) => Promise<boolean>;
	setBrush: (brush: BrushKind) => void;
	setLassoOptions: (opts: Partial<LassoOptions>) => void;
	beginStroke: () => void;
	endStroke: (opacity: number) => Promise<RasterHistoryEntry | null>;
	/** Discard in-progress stroke without compositing or undo entry. */
	cancelStroke: () => void;
	/** Upload an exact history patch into the committed document texture. */
	applyRasterPatch: (bounds: Rect, pixels: Uint8Array) => void;
	/** Read the entire committed document in tightly packed RGBA8 form. */
	readDocument: () => Promise<Uint8Array | null>;
	addSample: (
		x: number,
		y: number,
		brushDiameter: number,
		sizePressure: number,
		opacityPressure: number,
		color: string,
		spacingFactor?: number,
		viewZoom?: number
	) => void;
	/** Queue one time-based airbrush dab even when the pointer has not moved. */
	addTimedAirbrushDab: (
		x: number,
		y: number,
		brushDiameter: number,
		sizePressure: number,
		opacityPressure: number,
		color: string
	) => void;
	/** Flush path tools now; stamp brushes are encoded by the next present frame. */
	flushStamps: (color: string) => void;
	/** Sample document color at doc-space pixel; returns `#rrggbb` or null if out of bounds. */
	sampleColor: (x: number, y: number) => Promise<string | null>;
	/**
	 * Read a square patch around a doc-space point for the eyedropper loupe.
	 * `radius` is half-extent in pixels (patch is `2*radius+1` wide).
	 */
	samplePatch: (
		x: number,
		y: number,
		radius: number
	) => Promise<{
		width: number;
		height: number;
		pixels: Uint8ClampedArray;
		hex: string;
	} | null>;
	present: (view: ViewState, cssW: number, cssH: number, opacity: number, strokeActive: boolean) => void;
	destroy: () => void;
};
