struct Uniforms {
  // column-major 3x3 affine: doc px -> clip
  m0: vec3f,
  _pad0: f32,
  m1: vec3f,
  _pad1: f32,
  m2: vec3f,
  _pad2: f32,
  strokeOpacity: f32,
  strokeActive: f32,
  docSize: vec2f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var docTex: texture_2d<f32>;
@group(0) @binding(2) var strokeTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var out: VSOut;
  let x = f32(vi == 1u || vi == 2u || vi == 4u);
  let y = f32(vi == 2u || vi == 4u || vi == 5u);
  let doc = vec3f(x * u.docSize.x, y * u.docSize.y, 1.0);
  let clip = vec3f(
    dot(u.m0, doc),
    dot(u.m1, doc),
    dot(u.m2, doc),
  );
  out.position = vec4f(clip.xy, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4f {
  let d = textureSample(docTex, samp, input.uv);
  let s = textureSample(strokeTex, samp, input.uv);
  let a = s.a * u.strokeOpacity * u.strokeActive;
  let rgb = s.rgb * (u.strokeOpacity * u.strokeActive) + d.rgb * (1.0 - a);
  return vec4f(rgb, 1.0);
}
