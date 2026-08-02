struct Uniforms {
  opacity: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var strokeTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var out: VSOut;
  let x = f32(vi == 1u || vi == 2u || vi == 4u);
  let y = f32(vi == 2u || vi == 4u || vi == 5u);
  out.position = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  let s = textureSample(strokeTex, samp, input.uv);
  return vec4f(s.rgb * u.opacity, s.a * u.opacity);
}
