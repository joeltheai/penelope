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
	endStroke: (opacity: number) => void;
	/** Discard in-progress stroke without compositing or undo entry. */
	cancelStroke: () => void;
	undo: () => boolean;
	redo: () => boolean;
	canUndo: () => boolean;
	canRedo: () => boolean;
	addSample: (
		x: number,
		y: number,
		brushDiameter: number,
		sizePressure: number,
		opacityPressure: number,
		color: string,
		spacingFactor?: number
	) => void;
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
