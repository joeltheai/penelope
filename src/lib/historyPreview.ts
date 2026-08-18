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
	{ token: object; size: string; blobs: Map<string, Blob> }
>();

const MAX_CACHED_SNAPSHOTS = 48;
const MAX_REPLAY_CACHE_BYTES = 32 * 1024 * 1024;

type RasterPatchBatch = Awaited<ReturnType<PersistentHistory['getRasterPatch']>>;

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
	// SAFETY: callers pass freshly copied Uint8Arrays (baseline / region payloads) that fully
	// own an ArrayBuffer; ImageData requires an ArrayBuffer-backed clamped view.
	const clamped = new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength);
	context.putImageData(new ImageData(clamped, width, height), x, y);
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
	if (surface.scratch.width !== bounds.w) surface.scratch.width = bounds.w;
	if (surface.scratch.height !== bounds.h) surface.scratch.height = bounds.h;
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
			0.82
		);
	});
}

async function drawSnapshotBlob(surface: PreviewSurface, blob: Blob) {
	const bitmap = await createImageBitmap(blob);
	try {
		surface.context.drawImage(bitmap, 0, 0, surface.canvas.width, surface.canvas.height);
	} finally {
		bitmap.close();
	}
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
	const maxWidth = options.maxWidth ?? 320;
	const maxHeight = options.maxHeight ?? 210;
	const requested = new Set(nodeIds.map(snapshotKey));
	const existing = snapshotCaches.get(history);
	const token = history.getSnapshotCacheToken();
	const sizeKey = `${maxWidth}x${maxHeight}`;
	const cache =
		existing?.token === token && existing.size === sizeKey
			? existing
			: { token, size: sizeKey, blobs: new Map<string, Blob>() };
	if (cache !== existing) snapshotCaches.set(history, cache);

	if (!cache.blobs.has('__root__')) {
		throwIfAborted(options.signal);
		const surface = createSurface(graph.width, graph.height, maxWidth, maxHeight);
		drawBaseline(surface, history.getBaselinePixels(), graph.width, graph.height);
		cache.blobs.set('__root__', await canvasToBlob(surface.canvas));
	}

	const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
	const depthMemo = new Map<string, number>();
	const depthOf = (nodeId: string): number => {
		const cached = depthMemo.get(nodeId);
		if (cached !== undefined) return cached;
		const node = nodesById.get(nodeId);
		const depth = node?.parentId ? depthOf(node.parentId) + 1 : 1;
		depthMemo.set(nodeId, depth);
		return depth;
	};
	const missingNodeIds = nodeIds
		.filter((nodeId): nodeId is string => nodeId !== null && !cache.blobs.has(nodeId))
		.sort((a, b) => depthOf(a) - depthOf(b));

	for (const targetId of missingNodeIds) {
		throwIfAborted(options.signal);
		// SAFETY: chain collects ancestor HistoryNodes up to the first cached snapshot.
		const chain = [] as typeof graph.nodes;
		let cursor: string | null = targetId;
		while (cursor && !cache.blobs.has(cursor)) {
			const node = nodesById.get(cursor);
			if (!node) break;
			chain.push(node);
			cursor = node.parentId;
		}
		const baseBlob = cache.blobs.get(snapshotKey(cursor));
		if (!baseBlob) continue;

		const surface = createSurface(graph.width, graph.height, maxWidth, maxHeight);
		await drawSnapshotBlob(surface, baseBlob);
		const forward = chain.reverse();
		for (let start = 0; start < forward.length; start += 16) {
			throwIfAborted(options.signal);
			const nodes = forward.slice(start, start + 16);
			const patches = await history.getRasterPatches(nodes.map((node) => node.id));
			for (const regions of patches) {
				for (const region of regions) drawPatch(surface, region.bounds, region.after);
			}
		}
		cache.blobs.set(targetId, await canvasToBlob(surface.canvas));
	}

	// Keep recent checkpoints for fast incremental opens without retaining an
	// unbounded thumbnail archive during multi-hour sessions.
	if (cache.blobs.size > MAX_CACHED_SNAPSHOTS) {
		for (const key of cache.blobs.keys()) {
			if (cache.blobs.size <= MAX_CACHED_SNAPSHOTS) break;
			if (key === '__root__' || requested.has(key)) continue;
			cache.blobs.delete(key);
		}
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
	private readonly patchCache = new Map<string, RasterPatchBatch>();
	private patchCacheBytes = 0;

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
		if (cached) {
			this.patchCache.delete(nodeId);
			this.patchCache.set(nodeId, cached);
			return cached;
		}
		const patch = await this.history.getRasterPatch(nodeId);
		this.rememberPatch(nodeId, patch);
		return patch;
	}

	private rememberPatch(nodeId: string, patch: RasterPatchBatch) {
		const existing = this.patchCache.get(nodeId);
		if (existing) {
			this.patchCacheBytes -= existing.reduce(
				(sum, region) => sum + region.before.byteLength + region.after.byteLength,
				0
			);
			this.patchCache.delete(nodeId);
		}
		this.patchCache.set(nodeId, patch);
		this.patchCacheBytes += patch.reduce(
			(sum, region) => sum + region.before.byteLength + region.after.byteLength,
			0
		);
		while (this.patchCacheBytes > MAX_REPLAY_CACHE_BYTES && this.patchCache.size > 1) {
			// SAFETY: eviction only runs while patchCache.size > 1, so the first key exists and is a
			// nodeId string (Map preserves insertion order; only nodeId keys are ever set).
			const oldestId = this.patchCache.keys().next().value as string;
			const oldest = this.patchCache.get(oldestId)!;
			this.patchCache.delete(oldestId);
			this.patchCacheBytes -= oldest.reduce(
				(sum, region) => sum + region.before.byteLength + region.after.byteLength,
				0
			);
		}
	}

	private async patches(nodeIds: string[]) {
		const result = Array.from<RasterPatchBatch>({ length: nodeIds.length });
		const missingIds: string[] = [];
		const missingIndices: number[] = [];
		for (let index = 0; index < nodeIds.length; index++) {
			const nodeId = nodeIds[index]!;
			const cached = this.patchCache.get(nodeId);
			if (cached) result[index] = await this.patch(nodeId);
			else {
				missingIds.push(nodeId);
				missingIndices.push(index);
			}
		}
		if (missingIds.length > 0) {
			const loaded = await this.history.getRasterPatches(missingIds);
			for (let index = 0; index < loaded.length; index++) {
				const patch = loaded[index]!;
				const nodeId = missingIds[index]!;
				this.rememberPatch(nodeId, patch);
				result[missingIndices[index]!] = patch;
			}
		}
		return result;
	}

	async seek(index: number, signal?: AbortSignal) {
		const target = Math.max(0, Math.min(this.total, Math.round(index)));
		while (this.index > target) {
			throwIfAborted(signal);
			const count = Math.min(16, this.index - target);
			const nodes = Array.from({ length: count }, (_, offset) => this.path[this.index - 1 - offset]!);
			const batch = await this.patches(nodes.map((node) => node.id));
			for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
				throwIfAborted(signal);
				for (const patch of batch[nodeIndex]!) {
					putPixels(
						this.context,
						patch.before,
						patch.bounds.w,
						patch.bounds.h,
						patch.bounds.x,
						patch.bounds.y
					);
				}
				this.index--;
			}
		}
		while (this.index < target) {
			throwIfAborted(signal);
			const nodes = this.path.slice(this.index, Math.min(target, this.index + 16));
			const batch = await this.patches(nodes.map((node) => node.id));
			for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
				throwIfAborted(signal);
				for (const patch of batch[nodeIndex]!) {
					putPixels(
						this.context,
						patch.after,
						patch.bounds.w,
						patch.bounds.h,
						patch.bounds.x,
						patch.bounds.y
					);
				}
				this.index++;
			}
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
