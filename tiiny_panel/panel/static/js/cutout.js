/* The last step of Studio's AI cut-out for 3D. FLUX.2-klein Background-Remove, on the Tiiny, removes a picture's
   background but can't output transparency: it returns the object on a plain backdrop. TRELLIS.2 only leaves out a
   transparent background, so this turns that plain backdrop transparent. It works on the AI's output, never on the
   user's own photo. Cutout.* are pure functions on RGBA pixels (tested in Node); cutoutBlob() does the canvas part. */
'use strict';

const Cutout = (() => {
  const TOL = 12;       // colour difference (ΔE in Lab) still counted as the backdrop
  const SOFT = 12;      // ΔE over which an edge fades from clear to solid
  const HOLE = 0.0005;  // enclosed backdrop at least this share of the picture is cleared too (a mug's handle)
  const SPECK = 0.01;   // solid bits smaller than this share of the largest one are dropped

  function lab(r, g, b) {
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const R = lin(r), G = lin(g), B = lin(b);
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
    const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
    const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

  /* The backdrop: the median colour of the border, and how far 90% of the border stays from it. */
  function backdrop(px, w, h) {
    const idx = [];
    for (let x = 0; x < w; x++) idx.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) idx.push(y * w, y * w + w - 1);
    const med = c => { const v = Float64Array.from(idx, i => px[i * 4 + c]).sort(); return v[v.length >> 1]; };
    const rgb = [med(0), med(1), med(2)];
    const ref = lab(...rgb);
    const d = Float64Array.from(idx, i => dist(lab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]), ref)).sort();
    return {rgb, lab: ref, spread: d[Math.floor(d.length * 0.9)]};
  }

  /* Share of pixels that are already see-through: the AI output may come with transparency of its own. */
  function transparentShare(px) {
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] < 250) n++;
    return n / (px.length / 4);
  }

  /* Pixels joined to the start ones (4-neighbours) that pass `ok`; marks them in `mark` with `label`. Returns the count. */
  function flood(starts, ok, mark, label, w, h, queue) {
    let head = 0, tail = 0;
    for (const s of starts) if (!mark[s] && ok(s)) { mark[s] = label; queue[tail++] = s; }
    const last = w * (h - 1);
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      let j;
      if (x > 0 && !mark[j = i - 1] && ok(j)) { mark[j] = label; queue[tail++] = j; }
      if (x < w - 1 && !mark[j = i + 1] && ok(j)) { mark[j] = label; queue[tail++] = j; }
      if (i >= w && !mark[j = i - w] && ok(j)) { mark[j] = label; queue[tail++] = j; }
      if (i < last && !mark[j = i + w] && ok(j)) { mark[j] = label; queue[tail++] = j; }
    }
    return tail;
  }

  /* Alpha for every pixel: 0 on the backdrop, 255 on the object, a soft ramp on the edge. */
  function matte(px, w, h, {tol = TOL, soft = SOFT} = {}) {
    const n = w * h;
    const bg = backdrop(px, w, h);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = dist(lab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]), bg.lab);
    const alpha = new Uint8ClampedArray(n).fill(255);
    const mark = new Uint8Array(n);
    const queue = new Int32Array(n);
    // 1. the backdrop, grown from the border through clear backdrop pixels only
    const border = [];
    for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
    flood(border, i => d[i] <= tol, mark, 1, w, h, queue);
    // 2. enclosed backdrop of the same colour, big enough to be a real gap
    for (let i = 0; i < n; i++) {
      if (mark[i] || d[i] > tol) continue;
      const size = flood([i], j => d[j] <= tol, mark, 2, w, h, queue);
      const label = size >= HOLE * n ? 1 : 3;   // 3: too small, stays part of the object
      for (let k = 0; k < size; k++) mark[queue[k]] = label;
    }
    for (let i = 0; i < n; i++) if (mark[i] === 1) alpha[i] = 0;
    // 3. the edge: how much of each edge pixel is object. Its colour lies between the backdrop and the object's own
    //    colour next to it, so project it onto that line (a half-white edge pixel of a red object is half solid).
    const bgc = bg.rgb;
    const ring = new Uint8Array(n);  // 1: next to the backdrop, 2: one pixel further in
    const touches = (i, test) => { const x = i % w; return (x > 0 && test(i - 1)) || (x < w - 1 && test(i + 1)) || (i >= w && test(i - w)) || (i < n - w && test(i + w)); };
    for (let i = 0; i < n; i++) if (mark[i] !== 1 && touches(i, j => mark[j] === 1)) ring[i] = 1;
    for (let i = 0; i < n; i++) if (mark[i] !== 1 && !ring[i] && touches(i, j => ring[j] === 1)) ring[i] = 2;
    for (let i = 0; i < n; i++) {
      if (!ring[i]) continue;
      const x = i % w, y = (i - x) / w;
      let best = -1;
      for (let r = 1; r <= 3 && best < 0; r++) {  // the nearest pixels inside the object; the most object-like of them
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (mark[j] === 1 || ring[j]) continue;
          if (best < 0 || d[j] > d[best]) best = j;
        }
      }
      const o = best >= 0 ? best : i;
      const ov0 = px[o * 4] - bgc[0], ov1 = px[o * 4 + 1] - bgc[1], ov2 = px[o * 4 + 2] - bgc[2];
      const len2 = ov0 * ov0 + ov1 * ov1 + ov2 * ov2;
      if (len2 < 900) { if (d[i] < tol + soft) alpha[i] = Math.round(Math.max(0, d[i] - tol) / soft * 255); continue; }
      const dot = (px[i * 4] - bgc[0]) * ov0 + (px[i * 4 + 1] - bgc[1]) * ov1 + (px[i * 4 + 2] - bgc[2]) * ov2;
      alpha[i] = Math.round(Math.min(1, Math.max(0, dot / len2)) * 255);
    }
    // 4. specks: solid pieces much smaller than the largest one
    const piece = new Int32Array(n);
    const sizes = [0];
    for (let i = 0; i < n; i++) {
      if (piece[i] || alpha[i] < 128) continue;
      const label = sizes.length;
      sizes.push(flood([i], j => alpha[j] >= 128, piece, label, w, h, queue));
    }
    let largest = 0;
    for (const size of sizes) if (size > largest) largest = size;
    for (let i = 0; i < n; i++) if (piece[i] && sizes[piece[i]] < SPECK * largest) alpha[i] = 0;
    return {alpha, bg: bg.rgb, plain: bg.spread <= tol * 1.5};
  }

  /* RGBA pixels with the matte applied, and the backdrop colour taken back out of the edge pixels (no halo). */
  function apply(px, alpha, bg) {
    const out = new Uint8ClampedArray(px.length);
    for (let i = 0, p = 0; i < alpha.length; i++, p += 4) {
      const a = alpha[i] / 255;
      for (let c = 0; c < 3; c++) out[p + c] = a > 0 && a < 1 ? (px[p + c] - (1 - a) * bg[c]) / a : px[p + c];
      out[p + 3] = alpha[i];
    }
    return out;
  }

  /* The box around the solid part: {x0, y0, x1, y1} (inclusive), or null when nothing is solid. */
  function bbox(alpha, w, h, min = 128) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] < min) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return x1 < 0 ? null : {x0, y0, x1, y1};
  }

  /* The box with a margin of `pad` (a share of its longer side), kept inside the picture. */
  function padded(box, w, h, pad = 0.08) {
    const m = Math.round(Math.max(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1) * pad);
    return {x0: Math.max(0, box.x0 - m), y0: Math.max(0, box.y0 - m), x1: Math.min(w - 1, box.x1 + m), y1: Math.min(h - 1, box.y1 + m)};
  }

  return {lab, backdrop, transparentShare, matte, apply, bbox, padded};
})();

/* The AI's output (a URL) → a transparent PNG of just the object: {blob, url, width, height, plain, already}.
   `plain` is false when the AI's backdrop wasn't one even colour, so the cut-out may be rough. */
async function cutoutBlob(src, {maxSide = 1024} = {}) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('The cut-out picture couldn’t be read.'));
    i.src = src;
  });
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale)), hgt = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const g = c.getContext('2d', {willReadFrequently: true});
  g.drawImage(img, 0, 0, w, hgt);
  const px = g.getImageData(0, 0, w, hgt).data;
  let rgba, alpha, plain = true;
  const already = Cutout.transparentShare(px) >= 0.01;
  if (already) {
    rgba = px;
    alpha = Uint8ClampedArray.from({length: w * hgt}, (_, i) => px[i * 4 + 3]);
  } else {
    const m = Cutout.matte(px, w, hgt);
    rgba = Cutout.apply(px, m.alpha, m.bg);
    alpha = m.alpha;
    plain = m.plain;
  }
  const box = Cutout.bbox(alpha, w, hgt);
  if (!box) throw new Error('Nothing was left after removing the background. Try again.');
  const b = Cutout.padded(box, w, hgt);
  const cw = b.x1 - b.x0 + 1, ch = b.y1 - b.y0 + 1;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const og = out.getContext('2d');
  const crop = og.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) crop.data.set(rgba.subarray(((b.y0 + y) * w + b.x0) * 4, ((b.y0 + y) * w + b.x1 + 1) * 4), y * cw * 4);
  og.putImageData(crop, 0, 0);
  const blob = await new Promise((resolve, reject) => out.toBlob(x => x ? resolve(x) : reject(new Error('The cut-out couldn’t be saved.')), 'image/png'));
  return {blob, url: URL.createObjectURL(blob), width: cw, height: ch, plain, already};
}

if (typeof module === 'object' && module.exports) module.exports = {Cutout};
