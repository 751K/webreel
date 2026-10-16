// HEVC Main10 readback with WebGPU: the finished frame is copied into a texture
// straight from the compositing canvas, converted to P010 there (BT.709, limited
// range, 4:2:0) and read back, so the page sends 3 bytes per pixel instead of RGBA's 4
// and ffmpeg only encodes. The math is ffmpeg's (scale=out_color_matrix=bt709:
// out_range=tv), rounded the same way; chroma is the 2×2 average.
//
// P010: a W×H plane of 16-bit Y, then a (W/2)×(H/2) plane of 16-bit U,V pairs; each
// value is a 10-bit code shifted up by 6, little-endian.
const P010 = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<uniform> size: vec2<u32>;
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn code(v: f32) -> u32 { return u32(floor(v + 0.5)) << 6u; }
fn pair(a: f32, b: f32) -> u32 { return code(a) | (code(b) << 16u); }
// One invocation per 2×2 block: its four Y values (two words) and its U,V pair.
@compute @workgroup_size(16, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let half = size / 2u;
  if (id.x >= half.x || id.y >= half.y) { return; }
  let x = 2u * id.x; let y = 2u * id.y;
  let a = textureLoad(src, vec2u(x, y), 0).rgb;
  let b = textureLoad(src, vec2u(x + 1u, y), 0).rgb;
  let c = textureLoad(src, vec2u(x, y + 1u), 0).rgb;
  let d = textureLoad(src, vec2u(x + 1u, y + 1u), 0).rgb;
  out[y * half.x + id.x] = pair(64.0 + 876.0 * luma(a), 64.0 + 876.0 * luma(b));
  out[(y + 1u) * half.x + id.x] = pair(64.0 + 876.0 * luma(c), 64.0 + 876.0 * luma(d));
  let m = (a + b + c + d) * 0.25; let l = luma(m);
  out[size.y * half.x + id.y * half.x + id.x] = pair(512.0 + 896.0 * (m.b - l) / 1.8556, 512.0 + 896.0 * (m.r - l) / 1.5748);
}`;

export async function gpuFrames(W, H) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw Error('WebGPU is unavailable');
  const device = await adapter.requestDevice();
  const bytes = W * H * 3;
  const frame = device.createTexture({ size: [W, H], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT });
  const storage = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const sizes = device.createBuffer({ size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(sizes, 0, new Uint32Array([W, H]));
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: P010 }), entryPoint: 'main' } });
  const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: frame.createView() }, { binding: 1, resource: { buffer: storage } }, { binding: 2, resource: { buffer: sizes } }] });
  // Three readback buffers: up to two frames are still being read back or sent while
  // the next one draws.
  const staging = Array.from({ length: 3 }, () => device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
  let next = 0;
  const mapped = async (buffer, use) => { await buffer.mapAsync(GPUMapMode.READ); try { return use(new Uint8Array(buffer.getMappedRange())); } finally { buffer.unmap(); } };
  return {
    // Takes the canvas as it is now (a 2D canvas: WebGL canvases are copied as last
    // presented, which a canvas inside the snapshot never is).
    load(canvas) { device.queue.copyExternalImageToTexture({ source: canvas }, { texture: frame }, [W, H]); },
    // P010 bytes of the loaded frame; resolves later, while the next frame draws.
    readP010() {
      const buffer = staging[next]; next = (next + 1) % staging.length;
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(W / 2 / 16), Math.ceil(H / 2 / 8));
      pass.end();
      encoder.copyBufferToBuffer(storage, 0, buffer, 0, bytes);
      device.queue.submit([encoder.finish()]);
      return mapped(buffer, view => view.slice());
    },
    // RGBA of the loaded frame, for the spot checks.
    async readRGBA() {
      const row = Math.ceil(W * 4 / 256) * 256;
      const buffer = device.createBuffer({ size: row * H, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: frame }, { buffer, bytesPerRow: row }, [W, H]);
      device.queue.submit([encoder.finish()]);
      const data = await mapped(buffer, view => {
        const out = new Uint8ClampedArray(W * H * 4);
        for (let y = 0; y < H; y++) out.set(view.subarray(y * row, y * row + W * 4), y * W * 4);
        return out;
      });
      buffer.destroy();
      return new ImageData(data, W, H);
    }
  };
}
