import strokeWgsl from './shaders/stroke.wgsl?raw';
import compositeWgsl from './shaders/composite.wgsl?raw';
import presentWgsl from './shaders/present.wgsl?raw';

const DOC_W = 2000;
const DOC_H = 2000;
const BRUSH_SIZE = 128;
const MAX_STAMPS_PER_FLUSH = 4096;
const FLOATS_PER_VERT = 7;
const VERTS_PER_STAMP = 6;
const MAX_VERT_FLOATS = MAX_STAMPS_PER_FLUSH * VERTS_PER_STAMP * FLOATS_PER_VERT;

// Numeric WebGPU usage flags (TS DOM lib omits the GPU*Usage consts).
const TEX = {
	COPY_SRC: 0x01,
	COPY_DST: 0x02,
	TEXTURE_BINDING: 0x04,
	RENDER_ATTACHMENT: 0x10
} as const;
const BUF = {
	COPY_DST: 0x08,
	VERTEX: 0x20,
	UNIFORM: 0x40
} as const;

const CORNERS: [number, number][] = [
	[-1, -1],
	[1, -1],
	[1, 1],
	[-1, -1],
	[1, 1],
	[-1, 1]
];

export type ViewState = {
	x: number;
	y: number;
	zoom: number;
	rotation: number;
};

export type GpuPaint = {
	docW: number;
	docH: number;
	resize: (cssW: number, cssH: number) => void;
	beginStroke: () => void;
	endStroke: (opacity: number) => void;
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
	present: (view: ViewState, cssW: number, cssH: number, opacity: number, strokeActive: boolean) => void;
	destroy: () => void;
};

function parseColor(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	const full =
		h.length === 3
			? h
					.split('')
					.map((c) => c + c)
					.join('')
			: h;
	const n = Number.parseInt(full, 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Hard round tip with ~1px AA — reads like a pen, not an airbrush. */
function makeBrushPixels(size: number): Uint8Array {
	const pixels = new Uint8Array(size * size * 4);
	const aa = 1.25 / size;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = (x + 0.5) / size - 0.5;
			const dy = (y + 0.5) / size - 0.5;
			const r = Math.hypot(dx, dy) * 2; // 0 center → 1 at edge
			const a = r >= 1 ? 0 : r > 1 - aa ? (1 - r) / aa : 1;
			const i = (y * size + x) * 4;
			pixels[i] = 255;
			pixels[i + 1] = 255;
			pixels[i + 2] = 255;
			pixels[i + 3] = Math.round(a * 255);
		}
	}
	return pixels;
}

function appendStamp(
	out: Float32Array,
	offset: number,
	x: number,
	y: number,
	size: number,
	sizePressure: number,
	opacityPressure: number
) {
	let o = offset;
	for (const [cx, cy] of CORNERS) {
		out[o++] = x;
		out[o++] = y;
		out[o++] = cx;
		out[o++] = cy;
		out[o++] = size;
		out[o++] = sizePressure;
		out[o++] = opacityPressure;
	}
	return o;
}

export async function createGpuPaint(canvas: HTMLCanvasElement): Promise<GpuPaint> {
	if (!navigator.gpu) {
		if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
			throw new Error(
				'WebGPU needs a secure context. http://192.168.x.x will not work on iPad — use HTTPS, or open via localhost on the same device.'
			);
		}
		throw new Error(
			'WebGPU is not available here. On iPad it needs iPadOS 26+ (Safari 26); feature flags on older versions usually do not expose navigator.gpu.'
		);
	}

	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) throw new Error('No WebGPU adapter available (requestAdapter returned null)');

	const device = await adapter.requestDevice();
	const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
	if (!context) throw new Error('Failed to get WebGPU canvas context');

	const format = navigator.gpu.getPreferredCanvasFormat();
	context.configure({ device, format, alphaMode: 'opaque' });

	const layerUsage = TEX.RENDER_ATTACHMENT | TEX.TEXTURE_BINDING | TEX.COPY_SRC;

	const docTex = device.createTexture({
		size: [DOC_W, DOC_H],
		format: 'rgba8unorm',
		usage: layerUsage
	});
	const strokeTex = device.createTexture({
		size: [DOC_W, DOC_H],
		format: 'rgba8unorm',
		usage: layerUsage
	});

	const brushTex = device.createTexture({
		size: [BRUSH_SIZE, BRUSH_SIZE],
		format: 'rgba8unorm',
		usage: TEX.TEXTURE_BINDING | TEX.COPY_DST
	});
	device.queue.writeTexture(
		{ texture: brushTex },
		makeBrushPixels(BRUSH_SIZE),
		{ bytesPerRow: BRUSH_SIZE * 4 },
		[BRUSH_SIZE, BRUSH_SIZE]
	);

	const linearSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

	const strokeModule = device.createShaderModule({ code: strokeWgsl });
	const compositeModule = device.createShaderModule({ code: compositeWgsl });
	const presentModule = device.createShaderModule({ code: presentWgsl });

	const strokePipeline = device.createRenderPipeline({
		layout: 'auto',
		vertex: {
			module: strokeModule,
			entryPoint: 'vs',
			buffers: [
				{
					arrayStride: FLOATS_PER_VERT * 4,
					attributes: [
						{ shaderLocation: 0, offset: 0, format: 'float32x2' },
						{ shaderLocation: 1, offset: 8, format: 'float32x2' },
						{ shaderLocation: 2, offset: 16, format: 'float32' },
						{ shaderLocation: 3, offset: 20, format: 'float32' },
						{ shaderLocation: 4, offset: 24, format: 'float32' }
					]
				}
			]
		},
		fragment: {
			module: strokeModule,
			entryPoint: 'fs',
			targets: [
				{
					format: 'rgba8unorm',
					// Krita "wash" / stroke opacity: dabs take max coverage instead of
					// stacking (source-over). Crossing yourself in one stroke won't
					// keep darkening — only a new stroke after lift can layer.
					blend: {
						color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
						alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }
					}
				}
			]
		},
		primitive: { topology: 'triangle-list' }
	});

	const compositePipeline = device.createRenderPipeline({
		layout: 'auto',
		vertex: { module: compositeModule, entryPoint: 'vs' },
		fragment: {
			module: compositeModule,
			entryPoint: 'fs',
			targets: [
				{
					format: 'rgba8unorm',
					blend: {
						color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
						alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
					}
				}
			]
		},
		primitive: { topology: 'triangle-list' }
	});

	const presentPipeline = device.createRenderPipeline({
		layout: 'auto',
		vertex: { module: presentModule, entryPoint: 'vs' },
		fragment: {
			module: presentModule,
			entryPoint: 'fs',
			targets: [{ format }]
		},
		primitive: { topology: 'triangle-list' }
	});

	const strokeUniformBuf = device.createBuffer({
		size: 32,
		usage: BUF.UNIFORM | BUF.COPY_DST
	});
	const compositeUniformBuf = device.createBuffer({
		size: 16,
		usage: BUF.UNIFORM | BUF.COPY_DST
	});
	const presentUniformBuf = device.createBuffer({
		size: 64,
		usage: BUF.UNIFORM | BUF.COPY_DST
	});

	const vertexBuf = device.createBuffer({
		size: MAX_VERT_FLOATS * 4,
		usage: BUF.VERTEX | BUF.COPY_DST
	});
	const vertexCpu = new Float32Array(MAX_VERT_FLOATS);

	let strokeBindGroup = device.createBindGroup({
		layout: strokePipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: strokeUniformBuf } },
			{ binding: 1, resource: brushTex.createView() },
			{ binding: 2, resource: linearSamp }
		]
	});

	function rebuildLayerBindGroups() {
		compositeBindGroup = device.createBindGroup({
			layout: compositePipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: compositeUniformBuf } },
				{ binding: 1, resource: strokeTex.createView() },
				{ binding: 2, resource: linearSamp }
			]
		});
		presentBindGroup = device.createBindGroup({
			layout: presentPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: presentUniformBuf } },
				{ binding: 1, resource: docTex.createView() },
				{ binding: 2, resource: strokeTex.createView() },
				{ binding: 3, resource: linearSamp }
			]
		});
	}

	let compositeBindGroup!: GPUBindGroup;
	let presentBindGroup!: GPUBindGroup;
	rebuildLayerBindGroups();

	function clearTexture(tex: GPUTexture, color: GPUColor) {
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: tex.createView(),
					clearValue: color,
					loadOp: 'clear',
					storeOp: 'store'
				}
			]
		});
		pass.end();
		device.queue.submit([encoder.finish()]);
	}

	clearTexture(docTex, { r: 1, g: 1, b: 1, a: 1 });
	clearTexture(strokeTex, { r: 0, g: 0, b: 0, a: 0 });

	let stampCount = 0;
	let lastStamp: {
		x: number;
		y: number;
		sizePressure: number;
		opacityPressure: number;
	} | null = null;
	let lastColor = '#000000';
	let destroyed = false;

	function spacingFor(size: number, spacingFactor: number) {
		return Math.max(0.25, size * spacingFactor);
	}

	function queueStamp(
		x: number,
		y: number,
		size: number,
		sizePressure: number,
		opacityPressure: number
	) {
		if (stampCount >= MAX_STAMPS_PER_FLUSH) return;
		const offset = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		appendStamp(vertexCpu, offset, x, y, size, sizePressure, opacityPressure);
		stampCount++;
	}

	function paintStampsToStroke(color: string) {
		if (destroyed || stampCount === 0) return;

		const floats = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		device.queue.writeBuffer(vertexBuf, 0, vertexCpu, 0, floats);

		const [r, g, b] = parseColor(color);
		const u = new Float32Array(8);
		u[0] = DOC_W;
		u[1] = DOC_H;
		u[4] = r;
		u[5] = g;
		u[6] = b;
		u[7] = 1;
		device.queue.writeBuffer(strokeUniformBuf, 0, u);

		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: strokeTex.createView(),
					loadOp: 'load',
					storeOp: 'store'
				}
			]
		});
		pass.setPipeline(strokePipeline);
		pass.setBindGroup(0, strokeBindGroup);
		pass.setVertexBuffer(0, vertexBuf);
		pass.draw(stampCount * VERTS_PER_STAMP);
		pass.end();
		device.queue.submit([encoder.finish()]);
		stampCount = 0;
	}

	return {
		docW: DOC_W,
		docH: DOC_H,

		resize(cssW: number, cssH: number) {
			if (destroyed) return;
			const dpr = devicePixelRatio || 1;
			canvas.width = Math.max(1, Math.round(cssW * dpr));
			canvas.height = Math.max(1, Math.round(cssH * dpr));
			context.configure({ device, format, alphaMode: 'opaque' });
		},

		beginStroke() {
			if (destroyed) return;
			clearTexture(strokeTex, { r: 0, g: 0, b: 0, a: 0 });
			lastStamp = null;
			stampCount = 0;
		},

		endStroke(opacity: number) {
			if (destroyed) return;
			paintStampsToStroke(lastColor);

			const u = new Float32Array([opacity, 0, 0, 0]);
			device.queue.writeBuffer(compositeUniformBuf, 0, u);

			const encoder = device.createCommandEncoder();
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: docTex.createView(),
						loadOp: 'load',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(compositePipeline);
			pass.setBindGroup(0, compositeBindGroup);
			pass.draw(6);
			pass.end();
			device.queue.submit([encoder.finish()]);

			clearTexture(strokeTex, { r: 0, g: 0, b: 0, a: 0 });
			lastStamp = null;
			stampCount = 0;
		},

		addSample(
			x: number,
			y: number,
			brushDiameter: number,
			sizePressure: number,
			opacityPressure: number,
			color: string,
			spacingFactor = 0.06
		) {
			if (destroyed) return;
			lastColor = color;
			const sizeP = Math.min(1, Math.max(0, sizePressure));
			const opacP = Math.min(1, Math.max(0, opacityPressure));
			if (sizeP <= 0 && opacP <= 0) return;
			const spacing = spacingFor(brushDiameter * Math.max(sizeP, 0.05), spacingFactor);

			if (!lastStamp) {
				queueStamp(x, y, brushDiameter, sizeP, opacP);
				lastStamp = { x, y, sizePressure: sizeP, opacityPressure: opacP };
				if (stampCount >= MAX_STAMPS_PER_FLUSH) paintStampsToStroke(color);
				return;
			}

			const dx = x - lastStamp.x;
			const dy = y - lastStamp.y;
			const dist = Math.hypot(dx, dy);
			if (dist < spacing) return;

			const prevSizeP = lastStamp.sizePressure;
			const prevOpacP = lastStamp.opacityPressure;
			const steps = Math.floor(dist / spacing);
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				queueStamp(
					lastStamp.x + dx * t,
					lastStamp.y + dy * t,
					brushDiameter,
					prevSizeP + (sizeP - prevSizeP) * t,
					prevOpacP + (opacP - prevOpacP) * t
				);
				if (stampCount >= MAX_STAMPS_PER_FLUSH) paintStampsToStroke(color);
			}
			lastStamp = { x, y, sizePressure: sizeP, opacityPressure: opacP };
		},

		flushStamps(color: string) {
			paintStampsToStroke(color);
		},

		present(view: ViewState, cssW: number, cssH: number, opacity: number, strokeActive: boolean) {
			if (destroyed || cssW < 1 || cssH < 1) return;

			const cos = Math.cos(view.rotation);
			const sin = Math.sin(view.rotation);
			const zx = view.zoom;
			const zy = view.zoom;
			// doc px -> screen css px
			// p' = R * S * (p - center) + screenCenter + pan
			const cx = DOC_W / 2;
			const cy = DOC_H / 2;
			const a = cos * zx;
			const b = -sin * zy;
			const c = sin * zx;
			const d = cos * zy;
			const tx = -a * cx - b * cy + cssW / 2 + view.x;
			const ty = -c * cx - d * cy + cssH / 2 + view.y;
			// screen css -> clip: x_c = sx/cssW*2-1, y_c = 1-sy/cssH*2
			const sx = 2 / cssW;
			const sy = -2 / cssH;
			// clip = T_clip * T_screen
			const m00 = sx * a;
			const m01 = sx * b;
			const m02 = sx * tx - 1;
			const m10 = sy * c;
			const m11 = sy * d;
			const m12 = sy * ty + 1;

			const u = new Float32Array(16);
			// rows stored as vec3 + pad in WGSL struct
			u[0] = m00;
			u[1] = m01;
			u[2] = m02;
			u[4] = m10;
			u[5] = m11;
			u[6] = m12;
			u[8] = 0;
			u[9] = 0;
			u[10] = 1;
			u[12] = opacity;
			u[13] = strokeActive ? 1 : 0;
			u[14] = DOC_W;
			u[15] = DOC_H;
			device.queue.writeBuffer(presentUniformBuf, 0, u);

			const encoder = device.createCommandEncoder();
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: context.getCurrentTexture().createView(),
						clearValue: { r: 0.11, g: 0.11, b: 0.114, a: 1 },
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.setPipeline(presentPipeline);
			pass.setBindGroup(0, presentBindGroup);
			pass.draw(6);
			pass.end();
			device.queue.submit([encoder.finish()]);
		},

		destroy() {
			destroyed = true;
			docTex.destroy();
			strokeTex.destroy();
			brushTex.destroy();
			vertexBuf.destroy();
			strokeUniformBuf.destroy();
			compositeUniformBuf.destroy();
			presentUniformBuf.destroy();
			device.destroy();
		}
	};
}

export { DOC_W, DOC_H };
