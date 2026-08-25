import tgpu, { d, std, common } from 'typegpu';
import {
	GRID_BG,
	GRID_LINE,
	GRID_MAJOR,
	GRID_MAJOR_EVERY,
	GRID_SPACING
} from './constants';

type AnyRoot = Awaited<ReturnType<typeof tgpu.init>>;

/** Build stamp / composite / present pipelines (rebuild when doc textures change). */
export function createPaintPipelines(deps: {
	root: AnyRoot;
	format: GPUTextureFormat;
	stampLayout: any;
	vertexBuf: any;
	fanLayout: any;
	fanVertexBuf: any;
	lassoVertexBuf: any;
	strokeUniforms: any;
	fanUniforms: any;
	airbrushUniforms: any;
	compositeUniforms: any;
	presentUniforms: any;
	brushView: any;
	linearSamp: any;
	docViewSlot: any;
	strokeViewSlot: any;
	/** Mutable views rebound after document resize. */
	views: { docView: any; strokeView: any };
}) {
	const {
		root,
		format,
		stampLayout,
		vertexBuf,
		fanLayout,
		fanVertexBuf,
		lassoVertexBuf,
		strokeUniforms,
		fanUniforms,
		airbrushUniforms,
		compositeUniforms,
		presentUniforms,
		brushView,
		linearSamp,
		docViewSlot,
		strokeViewSlot,
		views
	} = deps;

	const fanVertex = tgpu.vertexFn({
		in: { pos: d.vec2f, opacity: d.f32 },
		out: { position: d.builtin.position, opacity: d.f32 }
	})((input) => {
		'use gpu';
		const clip = (input.pos / fanUniforms.$.resolution) * d.vec2f(2, -2) + d.vec2f(-1, 1);
		return { position: d.vec4f(clip, 0, 1), opacity: input.opacity };
	});

	const fanFragment = tgpu.fragmentFn({
		in: { opacity: d.f32 },
		out: d.vec4f
	})((input) => {
		'use gpu';
		const alpha = input.opacity;
		return d.vec4f(d.vec3f(fanUniforms.$.color) * alpha, alpha);
	});

	const lassoStencilVertex = tgpu.vertexFn({
		in: { pos: d.vec2f, opacity: d.f32 },
		out: { position: d.builtin.position }
	})((input) => {
		'use gpu';
		const clip = (input.pos / fanUniforms.$.resolution) * d.vec2f(2, -2) + d.vec2f(-1, 1);
		return { position: d.vec4f(clip, 0, 1) };
	});

	const lassoFillFragment = tgpu.fragmentFn({ out: d.vec4f })(() => {
		'use gpu';
		return d.vec4f(d.vec3f(fanUniforms.$.color), 1);
	});

	// Pipelines that sample textures capture views at shell creation time —
	// call rebuildDocSamplePipelines() after views.docView/strokeView change.

	const strokeVertex = tgpu.vertexFn({
		in: {
			pos: d.vec2f,
			corner: d.vec2f,
			size: d.f32,
			sizePressure: d.f32,
			opacityPressure: d.f32
		},
		out: {
			position: d.builtin.position,
			uv: d.vec2f,
			opacityPressure: d.f32
		}
	})((input) => {
		'use gpu';
		const half = input.size * 0.5 * input.sizePressure;
		const pixel = input.pos + input.corner * half;
		const clip = (pixel / strokeUniforms.$.resolution) * d.vec2f(2, -2) + d.vec2f(-1, 1);
		return {
			position: d.vec4f(clip, 0, 1),
			uv: input.corner * 0.5 + 0.5,
			opacityPressure: input.opacityPressure
		};
	});

	const strokeFragment = tgpu.fragmentFn({
		in: { uv: d.vec2f, opacityPressure: d.f32 },
		out: d.vec4f
	})((input) => {
		'use gpu';
		const mask = std.textureSample(brushView.$, linearSamp.$, input.uv).a;
		const color = d.vec4f(strokeUniforms.$.color);
		const a = mask * color.a * input.opacityPressure;
		return d.vec4f(color.rgb * a, a);
	});

	/** Airbrush dab vertex — also passes doc UVs to sample the stroke buffer. */
	const airbrushVertex = tgpu.vertexFn({
		in: {
			pos: d.vec2f,
			corner: d.vec2f,
			size: d.f32,
			sizePressure: d.f32,
			opacityPressure: d.f32
		},
		out: {
			position: d.builtin.position,
			tipUv: d.vec2f,
			docUv: d.vec2f,
			opacityPressure: d.f32
		}
	})((input) => {
		'use gpu';
		const half = input.size * 0.5 * input.sizePressure;
		const pixel = input.pos + input.corner * half;
		const res = airbrushUniforms.$.resolution;
		const clip = (pixel / res) * d.vec2f(2, -2) + d.vec2f(-1, 1);
		return {
			position: d.vec4f(clip, 0, 1),
			tipUv: input.corner * 0.5 + 0.5,
			docUv: pixel / res,
			opacityPressure: input.opacityPressure
		};
	});

	/**
	 * Pipelines that sample doc/stroke textures must be rebuilt when those
	 * textures are replaced (TypeGPU captures the view object at shell creation).
	 */
	let strokeAirbrushPipeline: ReturnType<typeof buildAirbrushPipeline>;
	let compositePipeline: ReturnType<typeof buildCompositePipeline>;
	let presentIdlePipeline: ReturnType<typeof buildPresentPipeline>;
	let presentStrokePipeline: ReturnType<typeof buildPresentPipeline>;

	function buildAirbrushPipeline() {
		/**
		 * Non-incremental airbrush wash: every dab approaches (but never
		 * exceeds) the current pressure opacity cap by flow × soft mask.
		 */
		const airbrushFragment = tgpu.fragmentFn({
			in: { tipUv: d.vec2f, docUv: d.vec2f, opacityPressure: d.f32 },
			out: d.vec4f
		})((input) => {
			'use gpu';
			const u = airbrushUniforms.$;
			const dst = std.textureSample(strokeViewSlot.$, linearSamp.$, input.docUv);
			const dstA = dst.a;

			// Soft gaussian-ish tip: dense center, long feathered falloff.
			const delta = input.tipUv - d.vec2f(0.5);
			const r = std.length(delta) * 2;
			const inside = std.select(0, 1, r < 1);
			const msk = std.exp(-r * r * 3.2) * inside;

			const opacity = input.opacityPressure;
			const targetA = std.max(dstA, opacity);
			const newA = std.mix(dstA, targetA, u.flow * msk);
			const C = d.vec3f(u.color);
			return d.vec4f(C * newA, newA);
		});

		return root
			.with(strokeViewSlot, views.strokeView)
			.createRenderPipeline({
				attribs: { ...stampLayout.attrib },
				vertex: airbrushVertex,
				fragment: airbrushFragment,
				targets: {
					format: 'rgba8unorm',
					blend: {
						color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
						alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
					}
				},
				primitive: { topology: 'triangle-list' }
			})
			.with(stampLayout, vertexBuf);
	}

	function buildCompositePipeline() {
		const compositeFragment = tgpu.fragmentFn({
			in: { uv: d.vec2f },
			out: d.vec4f
		})((input) => {
			'use gpu';
			const s = std.textureSample(strokeViewSlot.$, linearSamp.$, input.uv);
			const opacity = compositeUniforms.$.opacity;
			return d.vec4f(s.rgb * opacity, s.a * opacity);
		});

		return root.with(strokeViewSlot, views.strokeView).createRenderPipeline({
			vertex: common.fullScreenTriangle,
			fragment: compositeFragment,
			targets: {
				format: 'rgba8unorm',
				blend: {
					color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
					alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
				}
			},
			primitive: { topology: 'triangle-list' }
		});
	}

	function buildPresentPipeline(includeStroke: boolean) {
		const presentFragment = tgpu.fragmentFn({
			in: { uv: d.vec2f },
			out: d.vec4f
		})((input) => {
			'use gpu';
			const u = presentUniforms.$;
			const screen = input.uv * u.viewport;
			// Match PaintCanvas.screenToDoc: pan → unflip → unrotate → unzoom
			const x = (screen.x - u.center.x - u.pan.x) * u.flipX;
			const y = screen.y - u.center.y - u.pan.y;
			const c = u.inverseRotation.x;
			const s = u.inverseRotation.y;
			const ux = x * c - y * s;
			const uy = x * s + y * c;
			const docX = ux * u.invZoom + u.docSize.x * 0.5;
			const docY = uy * u.invZoom + u.docSize.y * 0.5;
			const docUv = d.vec2f(docX / u.docSize.x, docY / u.docSize.y);
			const inDoc = docUv.x >= 0 && docUv.x <= 1 && docUv.y >= 0 && docUv.y <= 1;

			if (inDoc) {
				// Explicit LOD is valid in non-uniform control flow. The idle pipeline
				// samples only the committed document; the live pipeline adds strokeTex.
				const docSample = std.textureSampleLevel(docViewSlot.$, linearSamp.$, docUv, 0);
				if (includeStroke) {
					const strokeSample = std.textureSampleLevel(
						strokeViewSlot.$,
						linearSamp.$,
						docUv,
						0
					);
					const factor = u.strokeOpacity;
					const a = strokeSample.a * factor;
					return d.vec4f(strokeSample.rgb * factor + docSample.rgb * (1 - a), 1);
				}
				return d.vec4f(docSample.rgb, 1);
			}

			// Screen-fixed backdrop grid. This branch runs only outside the document.
			const spacing = GRID_SPACING;
			const majorSpacing = spacing * GRID_MAJOR_EVERY;
			const fx = std.fract(screen.x / spacing);
			const fy = std.fract(screen.y / spacing);
			const dx = std.min(fx, 1 - fx) * spacing;
			const dy = std.min(fy, 1 - fy) * spacing;
			const dist = std.min(dx, dy);

			const mfx = std.fract(screen.x / majorSpacing);
			const mfy = std.fract(screen.y / majorSpacing);
			const mdx = std.min(mfx, 1 - mfx) * majorSpacing;
			const mdy = std.min(mfy, 1 - mfy) * majorSpacing;
			const majorDist = std.min(mdx, mdy);

			const half = 0.6;
			const minor = 1 - std.smoothstep(0, half, dist);
			const major = 1 - std.smoothstep(0, half * 1.25, majorDist);

			const bg = d.vec3f(GRID_BG[0], GRID_BG[1], GRID_BG[2]);
			const minorCol = d.vec3f(GRID_LINE[0], GRID_LINE[1], GRID_LINE[2]);
			const majorCol = d.vec3f(GRID_MAJOR[0], GRID_MAJOR[1], GRID_MAJOR[2]);
			const withMinor = std.mix(bg, minorCol, minor);
			const gridRgb = std.mix(withMinor, majorCol, major);
			return d.vec4f(gridRgb, 1);
		});

		return root
			.with(docViewSlot, views.docView)
			.with(strokeViewSlot, views.strokeView)
			.createRenderPipeline({
				vertex: common.fullScreenTriangle,
				fragment: presentFragment,
				targets: { format },
				primitive: { topology: 'triangle-list' }
			});
	}

	function rebuildDocSamplePipelines() {
		strokeAirbrushPipeline = buildAirbrushPipeline();
		compositePipeline = buildCompositePipeline();
		presentIdlePipeline = buildPresentPipeline(false);
		presentStrokePipeline = buildPresentPipeline(true);
	}

	const strokeWashPipeline = root
		.createRenderPipeline({
			attribs: { ...stampLayout.attrib },
			vertex: strokeVertex,
			fragment: strokeFragment,
			targets: {
				format: 'rgba8unorm',
				// Krita "wash": dabs take max coverage instead of stacking.
				blend: {
					color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
					alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }
				}
			},
			primitive: { topology: 'triangle-list' }
		})
		.with(stampLayout, vertexBuf);

	const fanPipeline = root
		.createRenderPipeline({
			attribs: { ...fanLayout.attrib },
			vertex: fanVertex,
			fragment: fanFragment,
			targets: {
				format: 'rgba8unorm',
				// A repeated sweep keeps the same falloff instead of accumulating opacity.
				blend: {
					color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
					alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }
				}
			},
			primitive: { topology: 'triangle-list' }
		})
		.with(fanLayout, fanVertexBuf);

	const lassoStencilPipeline = root
		.createRenderPipeline({
			attribs: { ...fanLayout.attrib },
			vertex: lassoStencilVertex,
			depthStencil: {
				format: 'stencil8',
				stencilFront: { compare: 'always', passOp: 'invert' },
				stencilBack: { compare: 'always', passOp: 'invert' },
				stencilReadMask: 1,
				stencilWriteMask: 1
			},
			primitive: { topology: 'triangle-list' }
		})
		.with(fanLayout, lassoVertexBuf);

	const lassoFillPipeline = root.createRenderPipeline({
		vertex: common.fullScreenTriangle,
		fragment: lassoFillFragment,
		targets: { format: 'rgba8unorm' },
		depthStencil: {
			format: 'stencil8',
			stencilFront: { compare: 'not-equal' },
			stencilBack: { compare: 'not-equal' },
			stencilReadMask: 1,
			stencilWriteMask: 0
		},
		primitive: { topology: 'triangle-list' }
	});


	return {
		strokeWashPipeline,
		fanPipeline,
		lassoStencilPipeline,
		lassoFillPipeline,
		get strokeAirbrushPipeline() {
			return strokeAirbrushPipeline;
		},
		get compositePipeline() {
			return compositePipeline;
		},
		get presentIdlePipeline() {
			return presentIdlePipeline;
		},
		get presentStrokePipeline() {
			return presentStrokePipeline;
		},
		rebuildDocSamplePipelines
	};
}
