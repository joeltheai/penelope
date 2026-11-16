export type ViewState = {
	x: number;
	y: number;
	zoom: number;
	rotation: number;
	flipX: number;
};

export type ToolKind = 'pen' | 'airbrush' | 'lasso' | 'fan' | 'fanFade';
export type BrushKind = ToolKind;

export type BrushBlend = 'wash' | 'buildup';

export type BrushSettings = {
	size: number;
	opacity: number;
	flow: number;
	spacing: number;
	hardness: number;
	smoothing: number;
	jitter: number;
	blend: BrushBlend;
	pressureSize: boolean;
	pressureOpacity: boolean;
};

export type Rect = { x: number; y: number; w: number; h: number };

export type RasterPatch = {
	bounds: Rect;
	before: Uint8Array;
	after: Uint8Array;
};

export type RasterHistoryEntry = RasterPatch[];

export type GpuPaintOptions = {
	width?: number;
	height?: number;
	pixels?: Uint8Array;
};

export type LassoMode = 'fill' | 'pull';

export type LassoOptions = {
	mode: LassoMode;
	splat: boolean;
};

export type EditApi = {
	undo: () => void;
	redo: () => void;
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
	setTool: (tool: ToolKind) => void;
	setLassoOptions: (opts: Partial<LassoOptions>) => void;
	setBrushSettings: (settings: Partial<BrushSettings>) => void;
	beginStroke: () => void;
	endStroke: (opacity: number) => Promise<RasterHistoryEntry | null>;
	cancelStroke: () => void;
	applyRasterPatch: (bounds: Rect, pixels: Uint8Array) => void;
	readRegion: (bounds: Rect) => Promise<Uint8Array | null>;
	addSample: (
		x: number,
		y: number,
		sizePressure: number,
		opacityPressure: number,
		color: string,
		viewZoom?: number
	) => void;
	addTimedAirbrushDab: (
		x: number,
		y: number,
		sizePressure: number,
		opacityPressure: number,
		color: string
	) => void;
	flushStamps: (color: string) => void;
	readDocument: () => Promise<Uint8Array | null>;
	present: (view: ViewState, cssW: number, cssH: number, opacity: number, strokeActive: boolean) => void;
	destroy: () => void;
};
