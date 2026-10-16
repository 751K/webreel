// Injected into the page by webreel/render.mjs. Drives the page frame by frame,
// draws each frame into a canvas and encodes it with WebCodecs, so the host only
// receives compressed bytes; for 10-bit and ProRes it sends raw frames instead.
import { concat, fileHeader, movieMetadata } from './mp4.mjs';
import { ssim } from './ssim.mjs';
import { describe, unsupported, drawMedia, fillBackground } from './media.mjs';
import { gpuFrames } from './gpu.mjs';

let reel = null; // the page's frame source: { frame(t), … }

// Errors with a stable code and the next step, reported by the host (--json).
const fail = (code, message, hint) => Object.assign(Error(message), { code, hint });

// clock.js (pages without window.webreel) replaces the page's timers and
// real.now(); the exporter itself always measures and waits in real time.
const real = window.__webreelClock?.real ?? { now: performance.now.bind(performance), setTimeout: setTimeout.bind(window), clearTimeout: clearTimeout.bind(window) };

// --- page contract --------------------------------------------------------

function resolveReel(config) {
  // window.film is the older name of the same contract.
  const page = window.webreel ?? window.film;
  if (typeof page?.frame === 'function') return { reel: page, name: page.name ?? (document.title || 'webreel'), duration: page.duration ?? null };
  if (typeof window.renderAt === 'function') {
    // Older pages: renderAt(scene, t) plus a scenes[] table. A page may also have an
    // element id="scenes", so prefer the lexical const over the named property.
    let scenes = Array.isArray(window.scenes) ? window.scenes : null;
    if (!scenes) try { scenes = window.eval('scenes'); } catch { scenes = null; }
    const scene = Array.isArray(scenes) ? scenes[config.scene] : null;
    if (Array.isArray(scenes) && !scene) throw fail('USAGE', `Scene ${config.scene} does not exist`, `pick --scene 0…${scenes.length - 1}`);
    if (scene?.bg === 'none' && !config.alpha) throw fail('USAGE', 'This scene is transparent; H.264/HEVC would silently drop the alpha', 'pass --alpha (ProRes 4444)');
    return { reel: { frame: t => window.renderAt(config.scene, t) }, name: scene?.name ?? (document.title || 'webreel'), duration: scene?.dur ?? null };
  }
  if (window.__webreelClock) {
    // No frame(t): drive the page's own clock, one video frame at a time.
    const fps = config.fpsNum / config.fpsDen;
    return { reel: { frame: t => window.__webreelClock.seek(t, fps) }, name: document.title || 'webreel', duration: null, clock: true };
  }
  throw fail('NO_FRAME_SOURCE', 'The page sets neither window.webreel = { frame(t), … } nor renderAt(scene, t)', 'drop --clock off, or set window.webreel');
}

function stageSize(page) {
  if (page.width || page.height) return [page.width, page.height];
  const viewport = document.querySelector('meta[name="viewport"]')?.content ?? '';
  const width = /(?:^|,)\s*width\s*=\s*(\d+)/.exec(viewport)?.[1], height = /(?:^|,)\s*height\s*=\s*(\d+)/.exec(viewport)?.[1];
  return width && height ? [Number(width), Number(height)] : [1920, 1080];
}

function webglRenderer() {
  try {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2') ?? new OffscreenCanvas(1, 1).getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl ? (debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown') : null;
  } catch { return null; }
}

window.__webreelPrepare = async config => {
  await document.fonts.ready;
  const resolved = resolveReel(config);
  reel = resolved.reel;
  if (reel.ready) await (typeof reel.ready === 'function' ? reel.ready() : reel.ready);
  const [width, height] = stageSize(reel);
  const sizeHint = 'set <meta name="viewport" content="width=W, height=H"> with even integers, at most 8192';
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw fail('PAGE', `Invalid stage size ${width}×${height}`, sizeHint);
  if ((width * config.scale) % 2 || (height * config.scale) % 2) throw fail('PAGE', `Video size ${width * config.scale}×${height * config.scale} must be even`, sizeHint);
  // `webreel check` reports an unknown length instead of failing on it.
  let total = resolved.duration, durationInferred = false, durationError = null;
  if (resolved.clock) {
    await reel.frame(config.start);
    if (config.duration === null) {
      const inferred = window.__webreelClock.inferDuration();
      if (inferred.error) durationError = `The page has no window.webreel and its length cannot be inferred (${inferred.error})`;
      else { total = inferred.duration; durationInferred = true; }
    }
  }
  const duration = config.duration ?? (total === null ? null : total - config.start);
  if (duration === null) {
    durationError ??= 'The page has no window.webreel.duration';
    if (config.command !== 'check') throw fail('NEEDS_DURATION', durationError, 'pass --duration SECONDS');
  }
  if (duration !== null && !(duration > 0)) throw fail('INTERVAL', 'Nothing to render: start is at or past the end', `use --start below ${total} s`);
  if (total !== null && config.start + duration > total + 1e-6) throw fail('INTERVAL', `Requested interval exceeds the page duration (${total} s)`, `keep --start + --duration within ${total} s`);
  await reel.frame(config.start);
  return { name: resolved.name, total, duration, durationInferred, durationError: duration === null ? durationError : null, clock: !!resolved.clock, width, height,
    frameCount: duration === null ? null : Math.round(duration * config.fpsNum / config.fpsDen), renderer: webglRenderer(),
    hic: typeof CanvasRenderingContext2D.prototype.drawElementImage === 'function' };
};

// --- frame sources -----------------------------------------------------------

const opaque = color => color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color);

// The page's backdrop: the body/html background, else the browser's white.
// With --alpha there is no white backdrop, only what the page itself paints.
function pageBackground(alpha) {
  for (const el of [document.body, document.documentElement]) {
    const color = getComputedStyle(el).backgroundColor;
    if (opaque(color)) return color;
  }
  return alpha ? null : '#fff';
}

function screenshotGrabber(endpoint, width, height) {
  return async () => {
    const response = await fetch(`${endpoint}/shot`, { method: 'POST' });
    if (!response.ok) throw Error(`Screenshot failed: ${response.status} ${await response.text()}`);
    const bitmap = await createImageBitmap(await response.blob());
    if (bitmap.width !== width || bitmap.height !== height) { bitmap.close(); throw Error(`Screenshot is ${bitmap.width}×${bitmap.height}, expected ${width}×${height}`); }
    return bitmap;
  };
}

// Fallback: Page.captureScreenshot for every frame, decoded back into a canvas.
function screenshotSource({ width, height, scale, endpoint, alpha, gpu }) {
  const W = width * scale, H = height * scale, grab = screenshotGrabber(endpoint, W, H);
  const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d', { alpha, willReadFrequently: false });
  return {
    kind: 'screenshot', canvas, paintSeconds: 0,
    async prepare() {},
    async draw(t) { await reel.frame(t); const bitmap = await grab(); ctx.clearRect(0, 0, W, H); ctx.drawImage(bitmap, 0, 0); bitmap.close(); gpu?.load(canvas); },
    read: () => gpu ? gpu.readRGBA() : ctx.getImageData(0, 0, W, H),
    unwrap() {}
  };
}

// Main path: the page's DOM is moved into <canvas layoutsubtree> and drawn by
// Chrome's own painter with drawElementImage. The content of canvases and videos
// is not part of that snapshot, so it is drawn first, underneath the DOM, with the
// CSS that applies to it reproduced by media.mjs.
function elementSource({ width, height, scale, clock, alpha, gpu }) {
  const keepAnimations = clock ? fn => clock.preserve(fn) : fn => fn();
  const W = width * scale, H = height * scale;
  const background = pageBackground(alpha);
  const host = document.createElement('canvas');
  host.width = W; host.height = H; host.setAttribute('layoutsubtree', '');
  host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;display:block;margin:0;padding:0;border:0;opacity:1;transform:none;filter:none;z-index:2147483647`;
  // Children of a layoutsubtree canvas do not resolve inset:0 / percentage sizes
  // against it, so the stage has an explicit pixel size.
  const stage = document.createElement('div');
  stage.style.cssText = `position:relative;width:${width}px;height:${height}px;overflow:hidden;margin:0;padding:0`;
  const moved = [...document.body.childNodes].filter(n => n.nodeName !== 'SCRIPT').map(n => [n, n.nextSibling]);
  keepAnimations(() => {
    for (const [node] of moved) stage.appendChild(node);
    host.appendChild(stage); document.body.appendChild(host);
  });
  const ctx = host.getContext('2d');
  const output = new OffscreenCanvas(W, H).getContext('2d', { alpha });
  const media = () => [...stage.querySelectorAll('canvas, video')];
  // The snapshot shows the content of nested canvases/videos unreliably (a stale,
  // partly drawn frame; black for alpha:false WebGL) and ignores object-fit and
  // object-position for it. So a clip-path with a hole cuts the content box out of
  // the snapshot, while the element's border, outline and outer shadow still paint
  // there. The page's own clip-path is kept for drawMedia; with one, the whole
  // element is hidden (unsupported() refuses borders and shadows in that case).
  const marks = new Map();
  const markMedia = () => {
    for (const el of media()) if (!marks.has(el)) {
      const cs = getComputedStyle(el);
      const [top, right, bottom, left] = ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(cs[`border${side}Width`]) + parseFloat(cs[`padding${side}`]));
      const far = 100000, hole = `polygon(evenodd, ${-far}px ${-far}px, ${far}px ${-far}px, ${far}px ${far}px, ${-far}px ${far}px, ${-far}px ${-far}px, ` +
        `${left}px ${top}px, calc(100% - ${right}px) ${top}px, calc(100% - ${right}px) calc(100% - ${bottom}px), ${left}px calc(100% - ${bottom}px), ${left}px ${top}px)`;
      marks.set(el, { fit: cs.objectFit, objectPosition: cs.objectPosition, clipPath: cs.clipPath,
        inline: [el.style.getPropertyValue('clip-path'), el.style.getPropertyPriority('clip-path')] });
      el.style.setProperty('clip-path', cs.clipPath === 'none' ? hole : 'inset(50%)', 'important');
    }
  };

  // A solid background always paints below the element's content and its
  // descendants, so it can be lifted out of the snapshot and filled under the
  // canvas instead (the canvas's own background as well as its ancestors').
  const lifted = new Map();
  for (const el of media()) for (let n = el; n && n !== stage; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (lifted.has(n) || !opaque(cs.backgroundColor) || cs.backgroundImage !== 'none') continue;
    lifted.set(n, { color: cs.backgroundColor, value: n.style.getPropertyValue('background-color'), priority: n.style.getPropertyPriority('background-color') });
  }
  for (const n of lifted.keys()) n.style.setProperty('background-color', 'transparent', 'important');
  const depth = n => { let d = 0; for (; n; n = n.parentElement) d++; return d; };
  const underlays = [...lifted.keys()].sort((a, b) => depth(a) - depth(b));

  const rect = (el, origin) => { const r = el.getBoundingClientRect(); return [(r.x - origin.x) * scale, (r.y - origin.y) * scale, r.width * scale, r.height * scale]; };
  let layer = null; // scratch canvas for filtered media
  function opacity(el) {
    if (getComputedStyle(el).visibility === 'hidden') return 0;
    let alpha = 1;
    for (let n = el; n && n !== stage; n = n.parentElement) alpha *= Number(getComputedStyle(n).opacity);
    return alpha;
  }
  function compose() {
    const origin = host.getBoundingClientRect();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, W, H); }
    const env = { stage, origin, scale };
    for (const n of underlays) {
      const [, , w, h] = rect(n, origin), alpha = opacity(n);
      if (w > 0 && h > 0 && alpha > 0.001) fillBackground(ctx, n, lifted.get(n).color, alpha, env, marks.get(n)?.clipPath);
    }
    for (const el of media()) {
      if (el.tagName === 'VIDEO' && el.readyState < 2) continue;
      if (!el.width && el.tagName === 'CANVAS') continue;
      const alpha = opacity(el), [, , w, h] = rect(el, origin);
      if (alpha <= 0.001 || w <= 0 || h <= 0) continue;
      // Checked before the first frame too; this catches styles that appear later.
      const mark = marks.get(el), reason = unsupported(el, stage, mark.clipPath);
      if (reason) throw fail('UNSUPPORTED_STYLE', `${reason}, which html-in-canvas cannot reproduce (it appeared during the export)`, 'rerun with --capture screenshot');
      layer ??= new OffscreenCanvas(W, H).getContext('2d');
      drawMedia(ctx, layer, el, { alpha, ...mark }, env);
    }
    ctx.globalAlpha = 1;
    ctx.drawElementImage(stage, 0, 0, W, H);
  }
  let paintMS = 0;
  const paint = draw => new Promise((resolve, reject) => {
    const timer = real.setTimeout(() => reject(Error('html-in-canvas paint event timed out')), 10000);
    host.onpaint = () => { real.clearTimeout(timer); try { resolve(draw()); } catch (error) { reject(error); } };
    host.requestPaint();
  });
  return {
    kind: 'html-in-canvas', canvas: output.canvas,
    get paintSeconds() { return paintMS / 1000; },
    // Refuse layouts this compositor cannot reproduce, before any frame is encoded.
    async prepare(t) {
      await reel.frame(t);
      const visible = media().filter(el => el.getBoundingClientRect().width > 0);
      for (const el of visible) { const reason = unsupported(el, stage); if (reason) throw Error(reason); }
      // backdrop-filter is applied in the snapshot, which does not see the canvas below.
      if (visible.length) {
        const boxes = visible.map(el => el.getBoundingClientRect());
        for (const n of stage.querySelectorAll('*')) {
          const value = getComputedStyle(n).backdropFilter;
          if (!value || value === 'none') continue;
          const r = n.getBoundingClientRect(), i = boxes.findIndex(b => r.right > b.left && r.left < b.right && r.bottom > b.top && r.top < b.bottom);
          if (i >= 0 && r.width > 0) throw Error(`${describe(n)} has a backdrop-filter over ${describe(visible[i])}`);
        }
      }
      markMedia();
      const covered = await paint(() => {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
        ctx.drawElementImage(stage, 0, 0, W, H);
        const origin = host.getBoundingClientRect(), found = [];
        for (const el of visible) {
          let [x, y, w, h] = rect(el, origin).map(Math.round);
          w = Math.min(W - Math.max(0, x), w + Math.min(0, x)); h = Math.min(H - Math.max(0, y), h + Math.min(0, y)); x = Math.max(0, x); y = Math.max(0, y);
          if (w <= 0 || h <= 0) continue;
          const data = ctx.getImageData(x, y, w, h).data;
          let solid = 0, total = 0;
          for (let i = 3; i < data.length; i += 4 * 97) { total++; if (data[i] >= 250) solid++; }
          if (solid / total > 0.5) found.push(`${describe(el)} (${Math.round(100 * solid / total)}% covered)`);
        }
        return found;
      });
      if (covered.length) throw Error(`Opaque page content sits over ${covered.join(', ')}; html-in-canvas can only draw canvases and videos underneath the DOM`);
    },
    async draw(t) {
      await reel.frame(t);
      markMedia();
      const began = real.now(); await paint(compose); paintMS += real.now() - began;
      // P010: WebGPU takes the frame from the host canvas itself.
      if (gpu) { gpu.load(host); return; }
      // Encode from a separate copy (opaque unless --alpha): frames from the
      // layoutsubtree host canvas make the encoder emit a new decoder configuration mid-stream.
      if (alpha) output.clearRect(0, 0, W, H);
      output.drawImage(host, 0, 0);
    },
    read: () => gpu ? gpu.readRGBA() : output.getImageData(0, 0, W, H),
    unwrap() {
      keepAnimations(() => {
        host.remove();
        for (const [el, { inline: [value, priority] }] of marks) { if (value) el.style.setProperty('clip-path', value, priority); else el.style.removeProperty('clip-path'); }
        for (let i = moved.length - 1; i >= 0; i--) { const [node, next] = moved[i]; document.body.insertBefore(node, next?.parentNode === document.body ? next : null); }
      });
      for (const [n, { value, priority }] of lifted) { if (value) n.style.setProperty('background-color', value, priority); else n.style.removeProperty('background-color'); }
    }
  };
}

// --- checks ---------------------------------------------------------------------

async function compareWithScreenshots(config, width, height, samples, imageOf) {
  const grab = screenshotGrabber(config.endpoint, width, height);
  const scratch = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  const checks = [];
  for (const [k, sample] of samples.entries()) {
    await reel.frame(sample.t);
    const bitmap = await grab(); scratch.clearRect(0, 0, width, height); scratch.drawImage(bitmap, 0, 0); bitmap.close();
    const score = ssim(await imageOf(sample, k), scratch.getImageData(0, 0, width, height).data, width, height, config.alpha);
    checks.push({ frame: sample.frame, t: sample.t, ...score, pass: score.mean >= config.checkMin && score.worstTile >= config.checkTile });
  }
  return checks; // the host decides what a failed check means (render: fail; check: report)
}

// Pages on the virtual clock cannot seek backwards, so their reference frames come
// from a fresh load that replays the clock up to each sample (see render.mjs).
window.__webreelReference = async (config, samples) => {
  const info = await window.__webreelPrepare(config);
  const W = info.width * config.scale, H = info.height * config.scale;
  return compareWithScreenshots(config, W, H, samples, async (sample, k) => {
    const response = await fetch(`${config.endpoint}/sample-get?k=${k}`, { method: 'POST' });
    if (!response.ok) throw Error(`Sample ${k} unavailable: ${response.status}`);
    return new Uint8ClampedArray(await response.arrayBuffer());
  });
};

// --- export -------------------------------------------------------------------

function codecString(codec, width, height, fps) {
  const pixels = width * height, high = pixels * fps > 3840 * 2160 * 30.5, huge = pixels > 4096 * 2304;
  if (codec === 'hevc') return `hvc1.1.6.L${huge ? 180 : high ? 156 : 153}.B0`;
  return `avc1.6400${huge ? '3c' : high ? '34' : '33'}`;
}

// 8-bit: WebCodecs in the page; only compressed samples go to the host, which
// writes them into an MP4 (see mp4.mjs).
async function webCodecsSink(config, W, H, post) {
  if (typeof VideoEncoder !== 'function') throw fail('ENCODER', 'WebCodecs VideoEncoder is unavailable', 'use --depth 10 or --codec prores (encoded by ffmpeg)');
  const fps = config.fpsNum / config.fpsDen;
  const settings = { codec: codecString(config.codec, W, H, fps), width: W, height: H, bitrate: config.bitrate, framerate: fps,
    latencyMode: 'realtime', hardwareAcceleration: config.software ? 'no-preference' : 'prefer-hardware',
    ...(config.codec === 'hevc' ? { hevc: { format: 'hevc' } } : { avc: { format: 'avc' } }) };
  const supported = await VideoEncoder.isConfigSupported(settings);
  if (!supported.supported) throw fail('ENCODER', `Unsupported WebCodecs configuration: ${JSON.stringify(settings)}`, 'try --codec hevc for large frames, or --depth 10 / --codec prores');
  let failure = null, pending = [], pendingBytes = 0, totalBytes = 0, description, colorSpace, waitMS = 0;
  const sizes = [], keys = [], waiters = new Set();
  const wake = () => { for (const resolve of [...waiters]) resolve(); };
  const progress = () => new Promise((resolve, reject) => {
    const ready = () => { real.clearTimeout(timer); waiters.delete(ready); resolve(); };
    const timer = real.setTimeout(() => { waiters.delete(ready); reject(Error('VideoEncoder queue stalled')); }, 30000);
    waiters.add(ready);
  });
  async function drain() {
    if (!pending.length) return;
    const batch = concat(...pending); pending = []; pendingBytes = 0;
    await post('bytes', batch); totalBytes += batch.byteLength;
  }
  const encoder = new VideoEncoder({
    error(error) { failure = error; wake(); },
    output(chunk, metadata) {
      try {
        const expected = Math.round(sizes.length * 1e6 / fps);
        if (Math.abs(chunk.timestamp - expected) > 1) throw Error(`Reordered/missing output at sample ${sizes.length}: ${chunk.timestamp} != ${expected}`);
        if (metadata?.decoderConfig?.description) {
          const next = new Uint8Array(metadata.decoderConfig.description);
          if (description && (next.length !== description.length || next.some((v, i) => description[i] !== v))) throw Error('Encoder configuration changed mid-stream');
          description = next.slice(); colorSpace = metadata.decoderConfig.colorSpace;
        }
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
        sizes.push(bytes.length); if (chunk.type === 'key') keys.push(sizes.length);
        pending.push(bytes); pendingBytes += bytes.length;
      } catch (error) { failure = error; }
      wake();
    }
  });
  encoder.addEventListener('dequeue', wake);
  const header = fileHeader();
  await post('bytes', header.bytes);
  totalBytes = header.bytes.length;
  encoder.configure(supported.config);
  return {
    get frames() { return sizes.length; },
    get waitSeconds() { return waitMS / 1000; },
    report: () => ({ codecString: settings.codec, hardwarePreference: settings.hardwareAcceleration, hardwareConfirmed: false, colorSpace, depth: 8 }),
    async ready(i) {
      const began = real.now();
      while (encoder.encodeQueueSize >= config.queue || i - sizes.length >= config.queue * 2) {
        if (failure) throw failure;
        await progress();
      }
      waitMS += real.now() - began;
      if (failure) throw failure;
    },
    async add(i, source) {
      const timestamp = Math.round(i * 1e6 / fps), next = Math.round((i + 1) * 1e6 / fps);
      const frame = new VideoFrame(source.canvas, { timestamp, duration: next - timestamp, alpha: 'discard' });
      try { encoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 }); } finally { frame.close(); }
      if (pendingBytes >= 1024 * 1024) await drain();
    },
    async flush() {
      await encoder.flush();
      if (failure) throw failure;
    },
    async finish() {
      await drain();
      await post('bytes', movieMetadata({ width: W, height: H, fpsNum: config.fpsNum, fpsDen: config.fpsDen, sizes, keys, description, codec: config.codec, colorSpace }));
      await post('finish', JSON.stringify({ mdatOffset: header.mdatOffset, mdatSize: totalBytes - header.mdatOffset }));
    },
    close() { if (encoder.state !== 'closed') encoder.close(); }
  };
}

// 10-bit and ProRes: Chrome's WebCodecs has neither HEVC Main10 nor ProRes, so raw
// RGBA frames go to the host, which converts them to BT.709 Y'CbCr and encodes with
// VideoToolbox (ffmpeg). The alpha channel of the frames is straight (not premultiplied).
// At most two frames are in transit; the host only answers once ffmpeg took a frame.
function rawSink(config, post) {
  let chain = Promise.resolve(), inTransit = 0, sent = 0, waitMS = 0, readMS = 0;
  const reader = config.readback === 'p010' ? gpu : null;
  if (config.readback === 'p010' && !reader) throw Error('P010 readback was not set up');
  return {
    get frames() { return sent; },
    get waitSeconds() { return waitMS / 1000; },
    report: () => ({ codecString: config.codec === 'prores' ? `prores_videotoolbox ${config.prores} (ffmpeg on the host)` : 'hevc_videotoolbox main10 (ffmpeg on the host)',
      depth: config.codec === 'prores' ? (['4444', 'xq'].includes(config.prores) ? 12 : 10) : 10, readback: reader ? 'p010 (WebGPU)' : 'rgba', readbackSeconds: readMS / 1000,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } }),
    async ready() {
      const began = real.now();
      if (inTransit >= 2) await chain;
      waitMS += real.now() - began;
    },
    async add(i, source) {
      const began = real.now();
      // P010: the conversion is queued on the GPU and read back while the next frame draws.
      const pixels = reader ? reader.readP010() : (await source.read()).data;
      readMS += real.now() - began;
      if (i === 0 && config.alpha && pixels.every((v, k) => (k & 3) !== 3 || v === 255))
        await post('warn', '--alpha, but the first frame is opaque everywhere; the page paints its own background (body, html or a full-size element)');
      inTransit++;
      chain = chain.then(async () => post(`raw?i=${i}`, await pixels)).then(() => { inTransit--; sent++; });
    },
    async flush() { await chain; },
    async finish() { await post('raw-end', ''); },
    close() {}
  };
}

// HEVC Main10 reads frames back as P010 converted with WebGPU (gpu.mjs). The host asks
// first, because ffmpeg is started for one input format or the other.
let gpu = null;
window.__webreelP010 = async (W, H) => {
  try { gpu = await gpuFrames(W, H); return null; } catch (error) { return error.message; }
};

const poster = config => async (suffix, body) => {
  const response = await fetch(`${config.endpoint}/${suffix}`, { method: 'POST', body });
  if (!response.ok) throw Error(`Host ${suffix} failed: ${response.status} ${await response.text()}`);
};

// html-in-canvas unless the page cannot be drawn that way (then screenshots).
async function chooseSource(config, info, post) {
  const geometry = { width: info.width, height: info.height, scale: config.scale, endpoint: config.endpoint, clock: info.clock ? window.__webreelClock : null, alpha: config.alpha, gpu: config.readback === 'p010' ? gpu : null };
  let source = null, fallbackReason = null;
  if (config.capture !== 'screenshot') {
    if (!info.hic) {
      if (config.capture === 'hic') throw fail('HIC_UNAVAILABLE', 'html-in-canvas is unavailable: Chrome needs --enable-blink-features=CanvasDrawElement', 'use a Chrome with html-in-canvas, or drop --capture hic');
      fallbackReason = 'html-in-canvas is unavailable in this Chrome';
    } else {
      try { source = elementSource(geometry); await source.prepare(config.start); }
      catch (error) {
        source?.unwrap(); source = null;
        if (config.capture === 'hic') throw fail('HIC_REFUSED', error.message, 'drop --capture hic to fall back to screenshots, or change the page (see the message)');
        fallbackReason = error.message;
      }
    }
  }
  if (!source) { source = screenshotSource(geometry); await source.prepare(config.start); }
  if (fallbackReason) await post('log', `html-in-canvas not used: ${fallbackReason}. Falling back to screenshots.`);
  return { source, fallbackReason };
}

// `webreel check`: draw a few frames the way the export would, save them as PNG
// (if asked) and compare them with screenshots, without encoding anything.
window.__webreelCheck = async (config, times) => {
  const info = await window.__webreelPrepare(config), post = poster(config);
  const W = info.width * config.scale, H = info.height * config.scale;
  const { source, fallbackReason } = await chooseSource(config, info, post);
  const samples = [];
  try {
    for (const [k, t] of times.entries()) {
      await source.draw(t);
      if (config.stills) await post(`still?k=${k}`, await source.canvas.convertToBlob({ type: 'image/png' }));
      if (source.kind === 'screenshot') continue;
      if (info.clock) { await post(`sample-put?k=${samples.length}`, (await source.read()).data); samples.push({ t }); }
      else samples.push({ t, image: await source.read() });
    }
  } finally { source.unwrap(); }
  const checks = samples.length && !info.clock ? await compareWithScreenshots(config, W, H, samples, sample => sample.image.data) : [];
  return { ...info, width: W, height: H, stage: { width: info.width, height: info.height }, capture: source.kind, fallbackReason,
    checks, pendingChecks: info.clock ? samples : [] };
};

window.__webreelExport = async config => {
  const wallStart = real.now();
  const info = await window.__webreelPrepare(config), post = poster(config);
  if (!info.frameCount) throw fail('INTERVAL', 'Requested interval contains no complete frames', 'make --duration at least one frame long');
  const W = info.width * config.scale, H = info.height * config.scale;
  const { source, fallbackReason } = await chooseSource(config, info, post);

  const fps = config.fpsNum / config.fpsDen;
  const sink = config.hostEncode ? rawSink(config, post) : await webCodecsSink(config, W, H, post);

  // Frames to compare against screenshots of the unmodified page afterwards.
  const checkCount = source.kind === 'screenshot' ? 0 : Math.min(config.check, info.frameCount);
  const checkAt = new Set(checkCount === 1 ? [0] : Array.from({ length: checkCount }, (_, k) => Math.round(k * (info.frameCount - 1) / (checkCount - 1))));
  const samples = [];

  try {
    let drawMS = 0, lastProgress = real.now();
    for (let i = 0; i < info.frameCount; i++) {
      await sink.ready(i);
      const t = config.start + i / fps, drawStart = real.now();
      await source.draw(t); drawMS += real.now() - drawStart;
      if (checkAt.has(i)) {
        if (info.clock) { await post(`sample-put?k=${samples.length}`, (await source.read()).data); samples.push({ frame: i, t }); }
        else samples.push({ frame: i, t, image: await source.read() });
      }
      await sink.add(i, source);
      if (real.now() - lastProgress > 2000) { await post('log', `${i + 1}/${info.frameCount} frames`); lastProgress = real.now(); }
    }
    await sink.flush();
    if (sink.frames !== info.frameCount) throw Error(`Encoded ${sink.frames}/${info.frameCount} frames`);
    const elapsed = (real.now() - wallStart) / 1000;

    // Spot checks: restore the page and compare with what the browser itself shows.
    // Virtual-clock pages are compared by the host after a fresh load instead.
    source.unwrap();
    const checks = samples.length && !info.clock ? await compareWithScreenshots(config, W, H, samples, sample => sample.image.data) : [];

    await sink.finish();
    return { name: info.name, total: info.total, duration: info.duration, frameCount: info.frameCount, width: W, height: H,
      renderer: info.renderer, capture: source.kind, fallbackReason, frames: sink.frames, elapsed, fps: sink.frames / elapsed,
      drawSeconds: drawMS / 1000, paintSeconds: source.paintSeconds, queueWaitSeconds: sink.waitSeconds,
      checkSeconds: (real.now() - wallStart) / 1000 - elapsed, checks, pendingChecks: info.clock ? samples : [],
      clock: info.clock, durationInferred: info.durationInferred, ...sink.report() };
  } finally { sink.close(); }
};
