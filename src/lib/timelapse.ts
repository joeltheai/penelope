import {
	BufferTarget,
	CanvasSource,
	Mp4OutputFormat,
	Output,
	Quality,
	canEncodeVideo
} from 'mediabunny';
import type { PersistentHistory } from '$lib/historyStore';

export type TimelapseOptions = {
	branchId?: string;
	fps: number;
	maxDimension: 720 | 1280 | 1920;
	bitrate?: number;
	onProgress?: (progress: number) => void;
};

function evenDimension(value: number) {
	const rounded = Math.max(2, Math.round(value));
	return rounded % 2 === 0 ? rounded : rounded + 1;
}

function fitOutputSize(width: number, height: number, maxDimension: number) {
	const scale = Math.min(1, maxDimension / Math.max(width, height));
	return {
		width: evenDimension(width * scale),
		height: evenDimension(height * scale)
	};
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

export async function renderTimelapse(
	history: PersistentHistory,
	options: TimelapseOptions
): Promise<Blob> {
	const fps = Math.max(1, Math.min(60, Math.round(options.fps)));
	const bitrate = options.bitrate ?? 7_500_000;
	const data = await history.getExportData(options.branchId);
	const outputSize = fitOutputSize(data.width, data.height, options.maxDimension);
	const supported = await canEncodeVideo('avc', {
		width: outputSize.width,
		height: outputSize.height,
		quality: new Quality({ bitrate })
	});
	if (!supported) throw new Error('H.264 video encoding is not supported in this browser');

	const documentCanvas = document.createElement('canvas');
	documentCanvas.width = data.width;
	documentCanvas.height = data.height;
	const documentContext = documentCanvas.getContext('2d', { alpha: false });
	if (!documentContext) throw new Error('Could not create document export canvas');

	const outputCanvas = document.createElement('canvas');
	outputCanvas.width = outputSize.width;
	outputCanvas.height = outputSize.height;
	const outputContext = outputCanvas.getContext('2d', { alpha: false });
	if (!outputContext) throw new Error('Could not create video export canvas');
	outputContext.imageSmoothingEnabled = true;
	outputContext.imageSmoothingQuality = 'high';

	const target = new BufferTarget();
	const output = new Output({ format: new Mp4OutputFormat(), target });
	const source = new CanvasSource(outputCanvas, {
		codec: 'avc',
		quality: new Quality({ bitrate })
	});
	output.addVideoTrack(source, { frameRate: fps });

	const frameDuration = 1 / fps;
	const startHoldFrames = Math.max(1, Math.round(fps * 0.5));
	const endHoldFrames = Math.max(1, Math.round(fps * 0.75));
	const totalFrames = startHoldFrames + data.frames.length + endHoldFrames;
	let emitted = 0;
	let timestamp = 0;

	const drawOutput = () => {
		outputContext.fillStyle = '#ffffff';
		outputContext.fillRect(0, 0, outputSize.width, outputSize.height);
		outputContext.drawImage(documentCanvas, 0, 0, outputSize.width, outputSize.height);
	};
	const emitFrame = async () => {
		drawOutput();
		await source.add(timestamp, frameDuration);
		timestamp += frameDuration;
		emitted++;
		options.onProgress?.(emitted / totalFrames);
	};

	putPixels(documentContext, data.baseline, data.width, data.height);
	await output.start();
	try {
		for (let i = 0; i < startHoldFrames; i++) await emitFrame();
		for (const frame of data.frames) {
			const after = await history.getAfterPatch(frame.id);
			putPixels(
				documentContext,
				after,
				frame.bounds.w,
				frame.bounds.h,
				frame.bounds.x,
				frame.bounds.y
			);
			await emitFrame();
		}
		for (let i = 0; i < endHoldFrames; i++) await emitFrame();
		await output.finalize();
	} catch (error) {
		if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
		throw error;
	}

	if (!target.buffer) throw new Error('Video encoder returned an empty file');
	options.onProgress?.(1);
	return new Blob([target.buffer], { type: 'video/mp4' });
}

export function downloadTimelapse(blob: Blob, filename = 'penelope-timelapse.mp4') {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
