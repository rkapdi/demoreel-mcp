// Declarative annotation renderer: a JSON list of marks → pixels. No GUI, fully repeatable.
// All coordinates are in image pixels, origin top-left.
import sharp from 'sharp';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

const FONT = "'SF Pro Display','Helvetica Neue',Helvetica,Arial,sans-serif";
export const PALETTE = { red: '#FF3B30', orange: '#FF9500', yellow: '#FFCC00', green: '#34C759', blue: '#0A84FF', purple: '#AF52DE', pink: '#FF2D55', white: '#FFFFFF', black: '#111111' };
export const GRADIENTS = {
  sunrise: ['#FF9A62', '#FF5E7E', '#7B5CFF'], ocean: ['#36D1DC', '#5B86E5'], violet: ['#8E2DE2', '#4A00E0'],
  mint: ['#A8FF78', '#78FFD6'], peach: ['#FFD3A5', '#FD6585'], midnight: ['#232526', '#414345'],
  sky: ['#89F7FE', '#66A6FF'], ember: ['#F83600', '#F9D423'], slate: ['#C9D6FF', '#E2E2E2'], forest: ['#134E5E', '#71B280'],
};
const col = (c, d = 'red') => PALETTE[c] || c || PALETTE[d];
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const expand = (p) => path.resolve(String(p).replace(/^~(?=\/)/, os.homedir()));

/** Rough text width estimate (no font metrics available in SVG-land). */
const textWidth = (s, size, weight = 600) => [...s].reduce((w, ch) => w + (/[ilI.,:;|!'1 ]/.test(ch) ? 0.3 : /[mwMW@]/.test(ch) ? 0.9 : /[A-Z0-9]/.test(ch) ? 0.66 : 0.55), 0) * size * (weight >= 600 ? 1.04 : 1);

function arrowPath(a, from, to) {
  const w = a.width ?? 6, color = col(a.color);
  const [x1, y1] = from, [x2, y2] = to;
  const ang = Math.atan2(y2 - y1, x2 - x1), head = a.head ?? w * 4.2;
  const bx = x2 - Math.cos(ang) * head * 0.85, by = y2 - Math.sin(ang) * head * 0.85;
  const p = (d) => `${x2 - Math.cos(ang + d) * head},${y2 - Math.sin(ang + d) * head}`;
  let shaft;
  if (a.curve) {
    const mx = (x1 + bx) / 2 - (by - y1) * a.curve, my = (y1 + by) / 2 + (bx - x1) * a.curve;
    shaft = `<path d="M${x1},${y1} Q${mx},${my} ${bx},${by}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
  } else shaft = `<line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
  return `${shaft}<polygon points="${x2},${y2} ${p(0.42)} ${p(-0.42)}" fill="${color}" stroke="${color}" stroke-width="${w * 0.4}" stroke-linejoin="round"/>`;
}

function label(a, W) {
  const size = a.size ?? 28, weight = a.weight ?? 600, lines = String(a.text).split('\n');
  const lh = size * 1.3, tw = Math.max(...lines.map((l) => textWidth(l, size, weight)));
  const padX = a.background === false ? 0 : size * 0.6, padY = a.background === false ? 0 : size * 0.38;
  const bw = tw + padX * 2, bh = lines.length * lh + padY * 2 - (lh - size) * 0.4;
  const anchor = a.anchor || 'left';
  let x = a.x; if (anchor === 'center') x -= bw / 2; else if (anchor === 'right') x -= bw;
  x = Math.max(4, Math.min(x, W - bw - 4));
  const bg = a.background === false ? '' : `<rect x="${x}" y="${a.y}" width="${bw}" height="${bh}" rx="${a.radius ?? size * 0.4}" fill="${col(a.background === true || a.background === undefined ? 'black' : a.background)}" fill-opacity="${a.backgroundOpacity ?? 0.88}"/>`;
  const text = lines.map((l, i) => `<text x="${x + padX}" y="${a.y + padY + size * 0.82 + i * lh}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${col(a.color, 'white')}">${esc(l)}</text>`).join('');
  return { svg: bg + text, box: { x, y: a.y, width: bw, height: bh } };
}

/** SVG for the vector marks (everything except blur/pixelate, which need the pixels underneath). */
export function marksSvg(marks, W, H, { shadow = true } = {}) {
  let body = '', defs = '';
  let n = 0;
  for (const a of marks) {
    const c = col(a.color), sw = a.strokeWidth ?? 5;
    switch (a.type) {
      case 'arrow': body += arrowPath(a, a.from, a.to); break;
      case 'line': body += `<line x1="${a.from[0]}" y1="${a.from[1]}" x2="${a.to[0]}" y2="${a.to[1]}" stroke="${c}" stroke-width="${a.width ?? 5}" stroke-linecap="round"${a.dashed ? ` stroke-dasharray="${(a.width ?? 5) * 2.5}"` : ''}/>`; break;
      case 'rect': body += `<rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="${a.radius ?? 10}" fill="${a.fill ? col(a.fill) : 'none'}" fill-opacity="${a.fillOpacity ?? 0.18}" stroke="${c}" stroke-width="${sw}"/>`; break;
      case 'ellipse': body += `<ellipse cx="${a.x + a.width / 2}" cy="${a.y + a.height / 2}" rx="${a.width / 2}" ry="${a.height / 2}" fill="${a.fill ? col(a.fill) : 'none'}" fill-opacity="${a.fillOpacity ?? 0.18}" stroke="${c}" stroke-width="${sw}"/>`; break;
      case 'highlight': body += `<rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="${a.radius ?? 6}" fill="${col(a.color, 'yellow')}" fill-opacity="${a.opacity ?? 0.38}" style="mix-blend-mode:multiply"/>`; break;
      case 'text': body += label(a, W).svg; break;
      case 'callout': {
        // A label with an arrow pointing from it to a target point.
        const l = label({ ...a, x: a.x, y: a.y }, W);
        const cx = l.box.x + l.box.width / 2, cy = l.box.y + l.box.height / 2;
        const [tx, ty] = a.target;
        const dx = tx - cx, dy = ty - cy;
        const k = Math.min(Math.abs((l.box.width / 2 + 6) / (dx || 1e-6)), Math.abs((l.box.height / 2 + 6) / (dy || 1e-6)));
        body += arrowPath({ color: a.arrowColor || a.background || 'black', width: a.arrowWidth ?? 5 }, [cx + dx * k, cy + dy * k], [tx, ty]) + l.svg;
        break;
      }
      case 'step': {
        const r = a.radius ?? 22; n = a.n ?? n + 1;
        body += `<circle cx="${a.x}" cy="${a.y}" r="${r}" fill="${c}" stroke="#fff" stroke-width="${r * 0.14}"/><text x="${a.x}" y="${a.y + r * 0.38}" text-anchor="middle" font-family="${FONT}" font-size="${r * 1.1}" font-weight="700" fill="${col(a.textColor, 'white')}">${esc(n)}</text>`;
        break;
      }
      case 'spotlight': {
        const id = `sp${defs.length}`, r = a.radius ?? 14;
        defs += `<mask id="${id}"><rect width="${W}" height="${H}" fill="white"/><rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="${r}" fill="black"/></mask>`;
        body += `<rect width="${W}" height="${H}" fill="#000" fill-opacity="${a.dim ?? 0.55}" mask="url(#${id})"/>` + (a.outline === false ? '' : `<rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="${r}" fill="none" stroke="${col(a.color, 'white')}" stroke-width="${a.strokeWidth ?? 3}"/>`);
        break;
      }
      case 'blur': case 'pixelate': break;
      default: throw new Error(`Unknown annotation type "${a.type}". Use: arrow, line, rect, ellipse, highlight, text, callout, step, spotlight, blur, pixelate.`);
    }
  }
  const filter = shadow ? `<filter id="ds" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.35"/></filter>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}${filter}</defs><g${shadow ? ' filter="url(#ds)"' : ''}>${body}</g></svg>`;
}

/** Background "frame": padding, gradient (preset name, colour, or list of colours), rounded corners, shadow. */
export function backgroundSvg(W, H, bg) {
  const stops = Array.isArray(bg.gradient) ? bg.gradient : GRADIENTS[bg.gradient] || (bg.color ? [col(bg.color), col(bg.color)] : GRADIENTS.sunrise);
  const ang = ((bg.angle ?? 135) * Math.PI) / 180;
  const x2 = 50 + Math.cos(ang) * 50, y2 = 50 + Math.sin(ang) * 50;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="${100 - x2}%" y1="${100 - y2}%" x2="${x2}%" y2="${y2}%">${stops.map((s, i) => `<stop offset="${(i / Math.max(1, stops.length - 1)) * 100}%" stop-color="${s}"/>`).join('')}</linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`;
}

/** Wrap an image buffer in a background frame. Returns { buffer, offset } where offset is the inner image's position. */
export async function frame(buffer, bg) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width, h = meta.height;
  const pad = bg.padding ?? Math.round(Math.max(w, h) * 0.06), r = bg.radius ?? 14;
  const W = w + pad * 2, H = h + pad * 2;
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" fill="#fff"/></svg>`);
  const rounded = await sharp(buffer).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const layers = [];
  if (bg.shadow !== false) {
    const blur = bg.shadowBlur ?? Math.max(8, Math.round(pad * 0.35));
    const sh = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${pad}" y="${pad + blur * 0.5}" width="${w}" height="${h}" rx="${r}" fill="#000" fill-opacity="${bg.shadowOpacity ?? 0.38}"/></svg>`);
    layers.push({ input: await sharp(sh).blur(blur).png().toBuffer() });
  }
  layers.push({ input: rounded, left: pad, top: pad });
  const out = await sharp(Buffer.from(backgroundSvg(W, H, bg))).composite(layers).png().toBuffer();
  return { buffer: out, offset: { x: pad, y: pad }, width: W, height: H };
}

async function redact(buffer, a, W, H) {
  const left = Math.max(0, Math.round(a.x)), top = Math.max(0, Math.round(a.y));
  const width = Math.min(W - left, Math.round(a.width)), height = Math.min(H - top, Math.round(a.height));
  if (width < 1 || height < 1) return buffer;
  const region = sharp(buffer).extract({ left, top, width, height });
  let patch;
  if (a.type === 'blur') patch = await region.blur(a.strength ?? 14).png().toBuffer();
  else {
    const block = a.block ?? 14;
    const small = await region.resize(Math.max(1, Math.round(width / block)), Math.max(1, Math.round(height / block)), { kernel: 'cubic', fit: 'fill' }).png().toBuffer();
    patch = await sharp(small).resize(width, height, { kernel: 'nearest', fit: 'fill' }).png().toBuffer();
  }
  return sharp(buffer).composite([{ input: patch, left, top }]).png().toBuffer();
}

/**
 * Annotate an image.
 * { input, output?, crop?, annotations: [...], background?, scale? }
 */
export async function annotateImage({ input, output, crop, annotations = [], background, shadow }) {
  const src = expand(input);
  let img = sharp(src);
  if (crop) img = img.extract({ left: Math.round(crop.x), top: Math.round(crop.y), width: Math.round(crop.width), height: Math.round(crop.height) });
  let buffer = await img.png().toBuffer();
  const { width: W, height: H } = await sharp(buffer).metadata();
  for (const a of annotations) if (a.type === 'blur' || a.type === 'pixelate') buffer = await redact(buffer, a, W, H);
  const vector = annotations.filter((a) => a.type !== 'blur' && a.type !== 'pixelate');
  if (vector.length) buffer = await sharp(buffer).composite([{ input: Buffer.from(marksSvg(vector, W, H, { shadow: shadow !== false })) }]).png().toBuffer();
  let size = { width: W, height: H };
  if (background) { const f = await frame(buffer, background); buffer = f.buffer; size = { width: f.width, height: f.height }; }
  const ext = path.extname(src);
  const dest = output ? expand(output) : src.slice(0, -ext.length) + '.annotated.png';
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (/\.jpe?g$/i.test(dest)) await sharp(buffer).flatten({ background: '#fff' }).jpeg({ quality: 92 }).toFile(dest);
  else await fs.writeFile(dest, buffer);
  return { file: dest, ...size, annotations: annotations.length };
}
