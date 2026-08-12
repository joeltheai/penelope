import type {
	HistoryGraphData,
	HistorySnapshot,
	PersistentHistory
} from '$lib/historyStore';

type PreviewSurface = {
	canvas: HTMLCanvasElement;
	context: CanvasRenderingContext2D;
	scratch: HTMLCanvasElement;
	scratchContext: CanvasRenderingContext2D;
	scale: number;
};

const snapshotCaches = new WeakMap<
	PersistentHistory,
	{ revision: string; blobs: Map<string, Blob> }
>();

function snapshotKey(nodeId: string | null) {
	return nodeId ?? '__root__';
}

function fitSize(width: number, height: number, maxWidth: number, maxHeight: number) {
	const scale = Math.min(maxWidth / width, maxHeight / height, 1);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
		scale
	};
}

function createSurface(
	docWidth: number,
	docHeight: number,
	maxWidth: number,
	maxHeight: number,
	target?: HTMLCanvasElement
): PreviewSurface {
	const size = fitSize(docWidth, docHeight, maxWidth, maxHeight);
	const canvas = target ?? document.createElement('canvas');
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext('2d', { alpha: false });
	if (!context) throw new Error('Could not create history preview canvas');
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = 'high';
	const scratch = document.createElement('canvas');
	const scratchContext = scratch.getContext('2d', { alpha: false });
	if (!scratchContext) throw new Error('Could not create history patch canvas');
	return { canvas, context, scratch, scratchContext, scale: size.scale };
}

function putPixels(
	context: CanvasRenderingContext2D,
	pixels: Uint8Array,
	width: number,
	height: number,
	x = 0,
	y = 0
) {
	const copy = new Uint8ClampedArray(pixels.byteLength);
	copy.set(pixels);
	context.putImageData(new ImageData(copy, width, height), x, y);
}

function drawBaseline(
	surface: PreviewSurface,
	pixels: Uint8Array,
	docWidth: number,
	docHeight: number
) {
	const source = document.createElement('canvas');
	source.width = docWidth;
	source.height = docHeight;
	const sourceContext = source.getContext('2d', { alpha: false });
	if (!sourceContext) throw new Error('Could not create history baseline canvas');
	putPixels(sourceContext, pixels, docWidth, docHeight);
	surface.context.fillStyle = '#ffffff';
	surface.context.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
	surface.context.drawImage(source, 0, 0, surface.canvas.width, surface.canvas.height);
}

function drawPatch(
	surface: PreviewSurface,
	bounds: { x: number; y: number; w: number; h: number },
	pixels: Uint8Array
) {
	surface.scratch.width = bounds.w;
	surface.scratch.height = bounds.h;
	putPixels(surface.scratchContext, pixels, bounds.w, bounds.h);
	surface.context.drawImage(
		surface.scratch,
		0,
		0,
		bounds.w,
		bounds.h,
		bounds.x * surface.scale,
		bounds.y * surface.scale,
		bounds.w * surface.scale,
		bounds.h * surface.scale
	);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('Could not encode history snapshot'))),
			'image/webp',
			0.94
		);
	});
}

function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new DOMException('History preview aborted', 'AbortError');
}

export async function renderHistorySnapshots(
	history: PersistentHistory,
	graph: HistoryGraphData,
	nodeIds: Array<string | null>,
	options: { maxWidth?: number; maxHeight?: number; signal?: AbortSignal } = {}
): Promise<HistorySnapshot[]> {
	const maxWidth = options.maxWidth ?? 640;
	const maxHeight = options.maxHeight ?? 420;
	const requested = new Set(nodeIds.map(snapshotKey));
	const existing = snapshotCaches.get(history);
	const cacheRevision = `${graph.revision}:${maxWidth}x${maxHeight}`;
	const cache =
		existing?.revision === cacheRevision
			? existing
			: { revision: cacheRevision, blobs: new Map<string, Blob>() };
	if (cache !== existing) snapshotCaches.set(history, cache);

	const missing = new Set([...requested].filter((key) => !cache.blobs.has(key)));
	if (missing.size) {
		throwIfAborted(options.signal);
		const surface = createSurface(graph.width, graph.height, maxWidth, maxHeight);
		drawBaseline(surface, history.getBaselinePixels(), graph.width, graph.height);
		if (missing.has('__root__')) {
			cache.blobs.set('__root__', await canvasToBlob(surface.canvas));
			missing.delete('__root__');
		}

		const children = new Map<string | null, typeof graph.nodes>();
		const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
		for (const node of graph.nodes) {
			const list = children.get(node.parentId) ?? [];
			list.push(node);
			children.set(node.parentId, list);
		}

		const visit = async (nodeId: string) => {
			throwIfAborted(options.signal);
			const node = nodesById.get(nodeId);
			if (!node) return;
			const patch = await history.getRasterPatch(node.id);
			drawPatch(surface, node.bounds, patch.after);
			const key = snapshotKey(node.id);
			if (missing.has(key)) {
				cache.blobs.set(key, await canvasToBlob(surface.canvas));
				missing.delete(key);
			}
			for (const child of children.get(node.id) ?? []) await visit(child.id);
			drawPatch(surface, node.bounds, patch.before);
		};

		for (const rootNode of children.get(null) ?? []) await visit(rootNode.id);
	}

	const size = fitSize(graph.width, graph.height, maxWidth, maxHeight);
	return nodeIds.flatMap((nodeId) => {
		const blob = cache.blobs.get(snapshotKey(nodeId));
		return blob ? [{ nodeId, blob, width: size.width, height: size.height }] : [];
	});
}

export class HistoryReplaySession {
	readonly total: number;
	index = 0;
	private readonly context: CanvasRenderingContext2D;
	private readonly path;
	private readonly patchCache = new Map<
		string,
		{ before: Uint8Array; after: Uint8Array }
	>();

	constructor(
		private readonly history: PersistentHistory,
		branchId: string,
		canvas: HTMLCanvasElement
	) {
		const graph = history.getGraphData();
		if (!graph.branches.some((branch) => branch.id === branchId)) {
			throw new Error('Unknown history branch');
		}
		this.path = history.getPath(branchId);
		this.total = this.path.length;
		canvas.width = graph.width;
		canvas.height = graph.height;
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Could not create replay canvas');
		this.context = context;
		putPixels(context, history.getBaselinePixels(), graph.width, graph.height);
	}

	private async patch(nodeId: string) {
		const cached = this.patchCache.get(nodeId);
		if (cached) return cached;
		const patch = await this.history.getRasterPatch(nodeId);
		this.patchCache.set(nodeId, patch);
		return patch;
	}

	async seek(index: number, signal?: AbortSignal) {
		const target = Math.max(0, Math.min(this.total, Math.round(index)));
		while (this.index > target) {
			throwIfAborted(signal);
			const node = this.path[this.index - 1]!;
			const patch = await this.patch(node.id);
			throwIfAborted(signal);
			putPixels(this.context, patch.before, node.bounds.w, node.bounds.h, node.bounds.x, node.bounds.y);
			this.index--;
		}
		while (this.index < target) {
			throwIfAborted(signal);
			const node = this.path[this.index]!;
			const patch = await this.patch(node.id);
			throwIfAborted(signal);
			putPixels(this.context, patch.after, node.bounds.w, node.bounds.h, node.bounds.x, node.bounds.y);
			this.index++;
		}
		return this.index;
	}

	async play(options: {
		fps: number;
		signal?: AbortSignal;
		onFrame?: (index: number) => void;
	}) {
		const delay = 1000 / Math.max(1, Math.min(60, options.fps));
		while (this.index < this.total) {
			throwIfAborted(options.signal);
			await this.seek(this.index + 1, options.signal);
			options.onFrame?.(this.index);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}
