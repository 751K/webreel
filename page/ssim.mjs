// Luma SSIM on non-overlapping 8×8 windows. Besides the whole-frame mean it
// reports the worst 128×128 tile, so a missing caption cannot hide inside an
// otherwise matching frame. With alpha, both images are compared composited over
// black and over white, so a difference in colour or in coverage both count.
const WIN = 8, TILE = 16; // tile = 16 windows = 128 px
const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;

export function ssim(a, b, width, height, alpha = false) {
  if (!alpha) return compare(a, b, width, height, null);
  const black = compare(a, b, width, height, 0), white = compare(a, b, width, height, 255);
  const worse = black.worstTile < white.worstTile ? black : white;
  return { mean: Math.min(black.mean, white.mean), worstTile: worse.worstTile, worstTileRect: worse.worstTileRect };
}

function compare(a, b, width, height, backdrop) {
  const gw = Math.floor(width / WIN), gh = Math.floor(height / WIN), n = WIN * WIN;
  const values = new Float32Array(gw * gh);
  let total = 0;
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = 0; y < WIN; y++) {
      let i = ((gy * WIN + y) * width + gx * WIN) * 4;
      for (let x = 0; x < WIN; x++, i += 4) {
        let ya = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
        let yb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
        if (backdrop !== null) { ya = backdrop + (ya - backdrop) * a[i + 3] / 255; yb = backdrop + (yb - backdrop) * b[i + 3] / 255; }
        sa += ya; sb += yb; saa += ya * ya; sbb += yb * yb; sab += ya * yb;
      }
    }
    const ma = sa / n, mb = sb / n;
    const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
    const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
    values[gy * gw + gx] = s; total += s;
  }
  let worst = { value: Infinity, rect: null };
  for (let ty = 0; ty < gh; ty += TILE) for (let tx = 0; tx < gw; tx += TILE) {
    let sum = 0, count = 0;
    for (let gy = ty; gy < Math.min(gh, ty + TILE); gy++) for (let gx = tx; gx < Math.min(gw, tx + TILE); gx++) { sum += values[gy * gw + gx]; count++; }
    const mean = sum / count;
    if (mean < worst.value) worst = { value: mean, rect: [tx * WIN, ty * WIN, Math.min(gw - tx, TILE) * WIN, Math.min(gh - ty, TILE) * WIN] };
  }
  return { mean: total / values.length, worstTile: worst.value, worstTileRect: worst.rect };
}
