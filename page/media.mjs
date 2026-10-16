// CSS of a <canvas>/<video> reproduced with Canvas 2D. html-in-canvas leaves the
// content of nested canvases and videos out of its snapshot, so export.mjs draws
// that content itself, underneath the DOM. Chrome still paints the element's own
// border, outline and outer shadow in the snapshot (export.mjs cuts only the content
// box out of it); this module handles what
// applies to the content: border-radius and padding, object-fit / object-position,
// filter, clip-path (basic shapes), mix-blend-mode, and the clipping of ancestors
// with overflow or clip-path. Anything else is reported by unsupported(), and the
// export falls back to screenshots.

export const describe = el => `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : el.classList.length ? '.' + el.classList[0] : ''}>`;

const BLEND = { normal: 'source-over', 'plus-lighter': 'lighter' };
for (const mode of ['multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']) BLEND[mode] = mode;

const masked = cs => [cs.maskImage, cs.webkitMaskImage, cs.webkitMaskBoxImageSource].some(v => v && v !== 'none');

// The element and its ancestors up to (excluding) the stage.
function chain(el, stage) { const list = []; for (let n = el; n && n !== stage; n = n.parentElement) list.push(n); return list; }

// Scale-and-translate transforms only (anything else is unsupported()).
function ownScale(cs) {
  let sx = 1, sy = 1;
  if (cs.transform !== 'none') { const m = new DOMMatrix(cs.transform); sx *= m.a; sy *= m.d; }
  if (cs.scale && cs.scale !== 'none') { const [a, b = a] = cs.scale.split(' ').map(Number); sx *= a; sy *= b; }
  return [sx, sy];
}

// The border box of n in its own CSS pixels (w, h) and how that maps onto the
// output: X = x + local * kx. Including every scale on the way to the stage.
function frame(n, env) {
  const r = n.getBoundingClientRect();
  let sx = 1, sy = 1;
  for (const m of chain(n, env.stage)) { const [a, b] = ownScale(getComputedStyle(m)); sx *= a; sy *= b; }
  return { x: (r.x - env.origin.x) * env.scale, y: (r.y - env.origin.y) * env.scale, kx: sx * env.scale, ky: sy * env.scale, w: r.width / sx, h: r.height / sy };
}

function length(token, reference) {
  if (token === '0') return 0;
  if (token.endsWith('%')) return reference * parseFloat(token) / 100;
  if (token.endsWith('px')) return parseFloat(token);
  throw Error(`unsupported length ${token}`);
}

// Corner radii of a border box (w × h) shrunk by the given insets, as roundRect
// takes them: top-left, top-right, bottom-right, bottom-left.
function radii(cs, w, h, [top, right, bottom, left] = [0, 0, 0, 0]) {
  const corner = (value, dx, dy) => {
    const [rx, ry = rx] = value.split(' ');
    return { x: Math.max(0, length(rx, w) - dx), y: Math.max(0, length(ry, h) - dy) };
  };
  return [corner(cs.borderTopLeftRadius, left, top), corner(cs.borderTopRightRadius, right, top),
    corner(cs.borderBottomRightRadius, right, bottom), corner(cs.borderBottomLeftRadius, left, bottom)];
}
const borders = cs => [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat);
const paddings = cs => [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);

function insetBox(cs, w, h, insets) {
  const [top, right, bottom, left] = insets;
  return { x: left, y: top, w: w - left - right, h: h - top - bottom, radii: radii(cs, w, h, insets) };
}
const roundedPath = box => { const p = new Path2D(); p.roundRect(box.x, box.y, Math.max(0, box.w), Math.max(0, box.h), box.radii); return p; };

// --- clip-path basic shapes --------------------------------------------------------

function split(text, separator = /\s+/) { return text.trim() ? text.trim().split(separator) : []; }
function sides(tokens) { const [a, b = a, c = a, d = b] = tokens; return [a, b, c, d]; }
function position(tokens, w, h) {
  if (!tokens.length) return [w / 2, h / 2];
  const words = { left: '0%', center: '50%', right: '100%', top: '0%', bottom: '100%' };
  if (tokens.length !== 2) throw Error(`unsupported clip-path position ${tokens.join(' ')}`);
  let [x, y] = tokens;
  if (x === 'top' || x === 'bottom' || y === 'left' || y === 'right') [x, y] = [y, x];
  return [length(words[x] ?? x, w), length(words[y] ?? y, h)];
}
function extent(token, w, h, x, y, axis) {
  // closest-side / farthest-side for circle (axis null) and ellipse (axis 'x' / 'y').
  const dx = [x, w - x], dy = [y, h - y];
  const pick = token === 'farthest-side' ? Math.max : Math.min;
  if (axis === 'x') return pick(...dx);
  if (axis === 'y') return pick(...dy);
  return pick(...dx, ...dy);
}

// Path2D for a computed clip-path value on a w × h border box, or null for none.
export function shapePath(value, w, h) {
  if (!value || value === 'none') return null;
  const match = /^(?:border-box\s+)?([a-z]+)\((.*)\)(?:\s+border-box)?$/.exec(value.trim());
  if (!match) throw Error(`unsupported clip-path ${value}`);
  const [, kind, args] = match;
  const path = new Path2D();
  let rule = 'nonzero';
  if (kind === 'inset') {
    const [box, round = ''] = args.split(/\s+round\s+/);
    const [top, right, bottom, left] = sides(split(box)).map((t, i) => length(t, i % 2 ? w : h));
    const rect = { x: left, y: top, w: w - left - right, h: h - top - bottom };
    const [horizontal, vertical = horizontal] = round.split('/').map(s => sides(split(s).length ? split(s) : ['0']));
    const r = i => ({ x: Math.max(0, length(horizontal[i], rect.w)), y: Math.max(0, length(vertical[i], rect.h)) });
    path.roundRect(rect.x, rect.y, Math.max(0, rect.w), Math.max(0, rect.h), [r(0), r(1), r(2), r(3)]);
  } else if (kind === 'circle' || kind === 'ellipse') {
    const [size, at = ''] = args.split(/\s*\bat\b\s*/);
    const [x, y] = position(split(at), w, h);
    const tokens = split(size);
    if (kind === 'circle') {
      const t = tokens[0] ?? 'closest-side';
      const r = /side$/.test(t) ? extent(t, w, h, x, y, null) : length(t, Math.hypot(w, h) / Math.SQRT2);
      path.arc(x, y, r, 0, 2 * Math.PI);
    } else {
      const [tx = 'closest-side', ty = 'closest-side'] = tokens;
      const rx = /side$/.test(tx) ? extent(tx, w, h, x, y, 'x') : length(tx, w), ry = /side$/.test(ty) ? extent(ty, w, h, x, y, 'y') : length(ty, h);
      path.ellipse(x, y, rx, ry, 0, 0, 2 * Math.PI);
    }
  } else if (kind === 'polygon') {
    const points = split(args, /\s*,\s*/);
    if (/^(nonzero|evenodd)$/.test(points[0])) rule = points.shift();
    points.forEach((point, i) => { const [px, py] = split(point); const x = length(px, w), y = length(py, h); i ? path.lineTo(x, y) : path.moveTo(x, y); });
    path.closePath();
  } else if (kind === 'path') {
    const parts = /^(?:(nonzero|evenodd)\s*,\s*)?"(.*)"$/.exec(args.trim());
    if (!parts) throw Error(`unsupported clip-path ${value}`);
    if (parts[1]) rule = parts[1];
    path.addPath(new Path2D(parts[2]));
  } else throw Error(`unsupported clip-path ${kind}()`);
  return { path, rule };
}

// --- per-element drawing ------------------------------------------------------------

function fitRect(fit, objectPosition, iw, ih, box) {
  let s;
  if (fit === 'fill') return [box.x, box.y, box.w, box.h];
  if (fit === 'contain') s = Math.min(box.w / iw, box.h / ih);
  else if (fit === 'cover') s = Math.max(box.w / iw, box.h / ih);
  else if (fit === 'none') s = 1;
  else if (fit === 'scale-down') s = Math.min(1, box.w / iw, box.h / ih);
  else throw Error(`unsupported object-fit ${fit}`);
  const w = iw * s, h = ih * s, [px, py] = split(objectPosition);
  if (!px || !py || split(objectPosition).length !== 2) throw Error(`unsupported object-position ${objectPosition}`);
  return [box.x + length(px, box.w - w), box.y + length(py, box.h - h), w, h];
}

const scaleFilter = (filter, k) => filter.replace(/(-?\d*\.?\d+(?:e[-+]?\d+)?)px/g, (_, n) => `${Number(n) * k}px`);

// Clip ctx to the overflow and clip-path of the ancestors of n.
function clipAncestors(ctx, n, env) {
  for (const a of chain(n.parentElement, env.stage)) {
    const cs = getComputedStyle(a), clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    if (!clips && cs.clipPath === 'none') continue;
    const f = frame(a, env), shape = shapePath(cs.clipPath, f.w, f.h);
    ctx.setTransform(f.kx, 0, 0, f.ky, f.x, f.y);
    if (clips) ctx.clip(roundedPath(insetBox(cs, f.w, f.h, borders(cs))));
    if (shape) ctx.clip(shape.path, shape.rule);
  }
}

// Why this element cannot be drawn faithfully, or null. clipPath is the element's
// own clip-path (the snapshot overrides it once the element is marked).
export function unsupported(el, stage, clipPath = getComputedStyle(el).clipPath) {
  const d = describe(el), own = getComputedStyle(el);
  if (clipPath !== 'none' && (borders(own).some(b => b > 0) || own.boxShadow !== 'none' || (own.outlineStyle !== 'none' && parseFloat(own.outlineWidth) > 0)))
    return `${d} has a clip-path together with a border, outline or shadow`;
  if (masked(own)) return `${d} has a CSS mask`;
  if (own.backgroundImage !== 'none') return `${d} has a background image`;
  if (/\binset\b/.test(own.boxShadow)) return `${d} has an inset box-shadow`;
  if (/url\(/.test(own.filter)) return `${d} uses an SVG filter`;
  if (!(own.mixBlendMode in BLEND)) return `${d} uses mix-blend-mode: ${own.mixBlendMode}`;
  for (const n of chain(el, stage)) {
    const cs = getComputedStyle(n), name = n === el ? d : `${describe(n)} around ${d}`;
    if (cs.transform !== 'none') {
      const m = new DOMMatrix(cs.transform);
      if (!m.is2D || Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6) return `${name} is rotated, skewed or 3D-transformed`;
    }
    if (cs.rotate && cs.rotate !== 'none') return `${name} is rotated`;
    if (ownScale(cs).some(s => s <= 0)) return `${name} is mirrored`;
    try { shapePath(n === el ? clipPath : cs.clipPath, 100, 100); } catch (error) { return `${name}: ${error.message}`; }
    if (n === el) continue;
    if (cs.filter !== 'none') return `${name} has a filter`;
    if (cs.mixBlendMode !== 'normal') return `${name} uses mix-blend-mode`;
    if (masked(cs)) return `${name} has a CSS mask`;
  }
  return null;
}

// Fill a background lifted out of the snapshot (n's own shape and clipping;
// clipPath as for unsupported()).
export function fillBackground(ctx, n, color, alpha, env, clipPath = getComputedStyle(n).clipPath) {
  const cs = getComputedStyle(n), f = frame(n, env);
  ctx.save();
  clipAncestors(ctx, n, env);
  ctx.setTransform(f.kx, 0, 0, f.ky, f.x, f.y);
  const shape = shapePath(clipPath, f.w, f.h);
  if (shape) ctx.clip(shape.path, shape.rule);
  const inset = cs.backgroundClip === 'content-box' ? borders(cs).map((b, i) => b + paddings(cs)[i]) : cs.backgroundClip === 'padding-box' ? borders(cs) : [0, 0, 0, 0];
  if (cs.filter !== 'none' && !/url\(/.test(cs.filter)) ctx.filter = scaleFilter(cs.filter, (f.kx + f.ky) / 2);
  ctx.globalAlpha = alpha; ctx.fillStyle = color;
  ctx.fill(roundedPath(insetBox(cs, f.w, f.h, inset)));
  ctx.restore();
}

// Draw the content of a canvas/video the way CSS would, with the element's own
// object-fit, object-position and clip-path as read before it was marked; layer is
// a scratch canvas for filters, which apply before clip-path.
export function drawMedia(ctx, layer, el, { alpha, fit, objectPosition, clipPath }, env) {
  const iw = el.tagName === 'VIDEO' ? el.videoWidth : el.width, ih = el.tagName === 'VIDEO' ? el.videoHeight : el.height;
  if (!iw || !ih) return;
  const cs = getComputedStyle(el), f = frame(el, env);
  if (f.w <= 0 || f.h <= 0) return;
  const content = insetBox(cs, f.w, f.h, borders(cs).map((b, i) => b + paddings(cs)[i]));
  if (content.w <= 0 || content.h <= 0) return;
  const [dx, dy, dw, dh] = fitRect(fit, objectPosition, iw, ih, content);
  const filter = cs.filter === 'none' ? null : scaleFilter(cs.filter, (f.kx + f.ky) / 2);
  const shape = shapePath(clipPath, f.w, f.h);
  const finish = target => {
    // ancestors' clipping, the element's clip-path, opacity and blending
    clipAncestors(target, el, env);
    target.setTransform(f.kx, 0, 0, f.ky, f.x, f.y);
    if (shape) target.clip(shape.path, shape.rule);
    target.globalAlpha = alpha; target.globalCompositeOperation = BLEND[cs.mixBlendMode];
  };
  const content2d = target => {
    target.setTransform(f.kx, 0, 0, f.ky, f.x, f.y);
    target.clip(roundedPath(content));
    target.drawImage(el, dx, dy, dw, dh);
  };
  if (!filter) { ctx.save(); finish(ctx); content2d(ctx); ctx.restore(); return; }
  layer.save(); layer.setTransform(1, 0, 0, 1, 0, 0); layer.clearRect(0, 0, layer.canvas.width, layer.canvas.height); content2d(layer); layer.restore();
  ctx.save(); finish(ctx); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.filter = filter; ctx.drawImage(layer.canvas, 0, 0); ctx.restore();
}
