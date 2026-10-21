export type ViewState = {
	x: number;
	y: number;
	zoom: number;
	rotation: number;
	flipX: number;
};

export type BrushKind = 'pen' | 'airbrush' | 'lasso' | 'fan' | 'fanFade';

export type Rect = { x: number; y: number; w: number; h: number };

export type RasterPatch = {
	bounds: Rect;
	before: Uint8Array;
	after: Uint8Array;
};

export type RasterHistoryEntry = RasterPatch[];

export type LassoMode = 'fill' | 'pull';

export type LassoOptions = {
	mode: LassoMode;
	splat: boolean;
};

export type GpuPaint = {
	docW: number;
	docH: number;
	resize: (cssW: number, cssH: number) => void;
	resizeDocument: (
		width: number,
		height: number,
		opts?: { cropX?: number; cropY?: number }
	) => Promise<boolean>;
	setBrush: (brush: BrushKind) => void;
	setLassoOptions: (opts: Partial<LassoOptions>) => void;
	beginStroke: () => void;
	endStroke: (opacity: number) => Promise<RasterHistoryEntry | null>;
	cancelStroke: () => void;
	applyRasterPatch: (bounds: Rect, pixels: Uint8Array) => void;
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
	addTimedAirbrushDab: (
		x: number,
		y: number,
		brushDiameter: number,
		sizePressure: number,
		opacityPressure: number,
		color: string
	) => void;
	flushStamps: (color: string) => void;
	sampleColor: (x: number, y: number) => Promise<string | null>;
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
