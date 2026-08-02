struct Uniforms {
  resolution: vec2f,
  _pad0: vec2f,
  color: vec4f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var brushTex: texture_2d<f32>;
@group(0) @binding(2) var brushSamp: sampler;

struct VSIn {
  @location(0) pos: vec2f,
  @location(1) corner: vec2f,
  @location(2) size: f32,
  @location(3) sizePressure: f32,
  @location(4) opacityPressure: f32,
}
struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) opacityPressure: f32,
}

@vertex
fn vs(input: VSIn) -> VSOut {
  var out: VSOut;
  let half = input.size * 0.5 * input.sizePressure;
  let pixel = input.pos + input.corner * half;
  let clip = (pixel / u.resolution) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  out.position = vec4f(clip, 0.0, 1.0);
  out.uv = input.corner * 0.5 + 0.5;
  out.opacityPressure = input.opacityPressure;
  return out;
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  let mask = textureSample(brushTex, brushSamp, input.uv).a;
  let a = mask * u.color.a * input.opacityPressure;
  return vec4f(u.color.rgb * a, a);
}
