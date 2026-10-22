import type { Rect } from './types';

type UndoEntry = {
	x: number;
	y: number;
	w: number;
	h: number;
	before: GPUTexture;
	after: GPUTexture | null;
	pixels: number;
};

export type GpuUndoStack = ReturnType<typeof createGpuUndoStack>;

export function createGpuUndoStack(
	device: GPUDevice,
	options?: { maxPixels?: number; maxEntries?: number }
) {
	const maxPixels = options?.maxPixels ?? 32 * 1024 * 1024;
	const maxEntries = options?.maxEntries ?? 64;

	let undoStack: UndoEntry[] = [];
	let redoStack: UndoEntry[] = [];
	let totalPixels = 0;

	function createTexture(w: number, h: number): GPUTexture {
		return device.createTexture({
			size: [w, h],
			format: 'rgba8unorm',
			usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
		});
	}

	function copyRegion(
		encoder: GPUCommandEncoder,
		src: GPUTexture,
		sx: number,
		sy: number,
		dst: GPUTexture,
		dx: number,
		dy: number,
		w: number,
		h: number
	) {
		encoder.copyTextureToTexture(
			{ texture: src, origin: { x: sx, y: sy, z: 0 } },
			{ texture: dst, origin: { x: dx, y: dy, z: 0 } },
			{ width: w, height: h, depthOrArrayLayers: 1 }
		);
	}

	function submit(build: (encoder: GPUCommandEncoder) => void) {
		const encoder = device.createCommandEncoder();
		build(encoder);
		device.queue.submit([encoder.finish()]);
	}

	function destroyTexture(texture: GPUTexture | null) {
		if (!texture) return;
		try {
			texture.destroy();
		} catch {
			/* already gone */
		}
	}

	function releaseEntry(entry: UndoEntry) {
		totalPixels -= entry.pixels * (entry.after ? 2 : 1);
		destroyTexture(entry.before);
		destroyTexture(entry.after);
		entry.after = null;
	}

	function prune() {
		while (undoStack.length > 1 && (totalPixels > maxPixels || undoStack.length > maxEntries)) {
			const oldest = undoStack.shift();
			if (!oldest) break;
			releaseEntry(oldest);
		}
		if (totalPixels < 0) totalPixels = 0;
	}

	function clearRedo() {
		for (const entry of redoStack) releaseEntry(entry);
		redoStack = [];
	}

	function capture(doc: GPUTexture, rect: Rect, externalEncoder?: GPUCommandEncoder) {
		if (rect.w < 1 || rect.h < 1) return;
		const before = createTexture(rect.w, rect.h);
		const encodeCopy = (encoder: GPUCommandEncoder) => {
			copyRegion(encoder, doc, rect.x, rect.y, before, 0, 0, rect.w, rect.h);
		};
		if (externalEncoder) encodeCopy(externalEncoder);
		else submit(encodeCopy);
		clearRedo();
		const pixels = rect.w * rect.h;
		undoStack.push({
			x: rect.x,
			y: rect.y,
			w: rect.w,
			h: rect.h,
			before,
			after: null,
			pixels
		});
		totalPixels += pixels;
		prune();
	}

	function undo(doc: GPUTexture): boolean {
		const entry = undoStack.pop();
		if (!entry) return false;
		if (!entry.after) {
			entry.after = createTexture(entry.w, entry.h);
			totalPixels += entry.pixels;
		}
		const after = entry.after;
		submit((encoder) => {
			copyRegion(encoder, doc, entry.x, entry.y, after, 0, 0, entry.w, entry.h);
			copyRegion(encoder, entry.before, 0, 0, doc, entry.x, entry.y, entry.w, entry.h);
		});
		redoStack.push(entry);
		return true;
	}

	function redo(doc: GPUTexture): boolean {
		const entry = redoStack.pop();
		if (!entry || !entry.after) return false;
		const after = entry.after;
		submit((encoder) => {
			copyRegion(encoder, after, 0, 0, doc, entry.x, entry.y, entry.w, entry.h);
		});
		undoStack.push(entry);
		return true;
	}

	function clear() {
		for (const entry of undoStack) releaseEntry(entry);
		for (const entry of redoStack) releaseEntry(entry);
		undoStack = [];
		redoStack = [];
		totalPixels = 0;
	}

	return {
		capture,
		undo,
		redo,
		clear,
		canUndo: () => undoStack.length > 0,
		canRedo: () => redoStack.length > 0
	};
}
