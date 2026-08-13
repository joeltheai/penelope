import { d } from 'typegpu';

export const StampVertex = d.unstruct({
	pos: d.float32x2,
	corner: d.float32x2,
	size: d.float32,
	sizePressure: d.float32,
	opacityPressure: d.float32
});

export const FanVertex = d.unstruct({
	pos: d.float32x2,
	opacity: d.float32
});

export const StrokeUniforms = d.struct({
	resolution: d.vec2f,
	color: d.vec4f
});

export const FanUniforms = d.struct({
	resolution: d.vec2f,
	color: d.vec3f
});

/** Krita-style Alpha Darken params for airbrush wash dabs. */
export const AirbrushUniforms = d.struct({
	resolution: d.vec2f,
	color: d.vec3f,
	flow: d.f32
});

export const CompositeUniforms = d.struct({
	opacity: d.f32
});

/** Camera + present (inverse screen→doc map). */
export const PresentUniforms = d.struct({
	viewport: d.vec2f,
	center: d.vec2f,
	pan: d.vec2f,
	zoom: d.f32,
	rotate: d.f32,
	/** View-only mirror: 1 = normal, -1 = flip across vertical axis. */
	flipX: d.f32,
	strokeOpacity: d.f32,
	strokeActive: d.f32,
	docSize: d.vec2f
});
