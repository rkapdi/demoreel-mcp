// Post-production for recordings: zooms, timed annotations, captions, framed background,
// intro/outro cards, trim, speed, GIF export. Everything is rendered with ffmpeg from a JSON spec.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { marksSvg, backgroundSvg, expand } from './annotate.js';

const exec = promisify(execFile);
const even = (n) => Math.round(n / 2) * 2;
const f3 = (n) => Number(n).toFixed(3);

export async function probe(file) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', expand(file)]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error(`No video stream in ${file}`);
  const [a, b] = (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate).split('/').map(Number);
  return {
    width: v.width, height: v.height, fps: Math.min(60, Math.round((a / (b || 1)) * 100) / 100) || 30,
    duration: Number(j.format.duration ?? v.duration), audioStreams: j.streams.filter((s) => s.codec_type === 'audio').length,
    sizeBytes: Number(j.format.size),
  };
}

/**
 * Turn a list of click events into zoom segments.
 * events: [{ t, x, y }] in video seconds / video pixels.
 */
export function zoomsFromClicks(events, { scale = 1.7, lead = 0.7, hold = 1.6, width = 1920, duration = Infinity } = {}) {
  const zooms = [];
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const last = zooms[zooms.length - 1];
    const near = last && Math.hypot(e.x - last.x, e.y - last.y) < width * 0.22;
    if (last && e.t - lead <= last.end && near) { last.end = Math.min(duration, e.t + hold); continue; }
    const start = Math.max(last ? last.end : 0, e.t - lead, 0);
    const end = Math.min(duration, e.t + hold);
    if (end - start > 0.6) zooms.push({ start, end, x: e.x, y: e.y, scale });
  }
  return zooms;
}

async function cardPng(file, W, H, card) {
  const title = String(card.title || ''), sub = String(card.subtitle || '');
  const ts = card.titleSize ?? Math.round(H * 0.09), ss = card.subtitleSize ?? Math.round(H * 0.04);
  const font = "'SF Pro Display','Helvetica Neue',Helvetica,Arial,sans-serif";
  const escX = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const cy = H / 2 - (sub ? ss * 0.9 : 0);
  const text = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="${W / 2}" y="${cy + ts * 0.35}" text-anchor="middle" font-family="${font}" font-size="${ts}" font-weight="700" fill="${card.color || '#fff'}">${escX(title)}</text>${sub ? `<text x="${W / 2}" y="${cy + ts * 0.35 + ss * 1.9}" text-anchor="middle" font-family="${font}" font-size="${ss}" font-weight="500" fill="${card.color || '#fff'}" fill-opacity="0.85">${escX(sub)}</text>` : ''}</svg>`;
  const layers = [{ input: Buffer.from(text) }];
  if (card.logo) {
    const lh = Math.round(H * 0.14);
    const logo = await sharp(expand(card.logo)).resize({ height: lh }).png().toBuffer();
    const lm = await sharp(logo).metadata();
    layers.unshift({ input: logo, left: Math.round((W - lm.width) / 2), top: Math.max(0, Math.round(cy - ts - lh * 1.1)) });
  }
  await sharp(Buffer.from(backgroundSvg(W, H, card.background || { gradient: 'midnight' }))).composite(layers).png().toFile(file);
}

/**
 * polishVideo(spec) — every time value is in seconds of the SOURCE video; coordinates are source pixels.
 */
export async function polishVideo(spec) {
  const input = expand(spec.input);
  const info = await probe(input);
  const format = spec.format || (/\.gif$/i.test(spec.output || '') ? 'gif' : 'mp4');
  const ext = path.extname(input);
  const output = spec.output ? expand(spec.output) : `${input.slice(0, -ext.length)}.polished.${format}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'demoreel-'));
  try {
    const t0 = Math.max(0, spec.trim?.start ?? 0);
    const t1 = Math.min(info.duration, spec.trim?.end ?? info.duration);
    const dur = t1 - t0;
    if (dur <= 0.1) throw new Error('Trim leaves no video.');
    const W = even(info.width), H = even(info.height), fps = spec.fps || info.fps;
    const rel = (t) => Math.max(0, Math.min(dur, t - t0));
    const inputs = ['-i', input];
    let nIn = 1;
    const addImage = (file, seconds) => { inputs.push('-loop', '1', '-framerate', String(fps), '-t', f3(seconds), '-i', file); return nIn++; };
    const chains = [];
    let cur = 'v0';
    chains.push(`[0:v]trim=start=${f3(t0)}:end=${f3(t1)},setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:flags=lanczos,setsar=1[${cur}]`);
    let n = 0;
    const next = () => `v${++n}`;
    const fadeD = 0.18;
    const overlayTimed = (idx, s, e, x = 0, y = 0) => {
      const o = `o${idx}`, out = next();
      const d = Math.min(fadeD, (e - s) / 2);
      chains.push(`[${idx}:v]format=rgba,fade=t=in:st=${f3(s)}:d=${f3(d)}:alpha=1,fade=t=out:st=${f3(e - d)}:d=${f3(d)}:alpha=1[${o}]`);
      chains.push(`[${cur}][${o}]overlay=${x}:${y}:enable='between(t,${f3(s)},${f3(e)})'[${out}]`);
      cur = out;
    };

    // 1. redactions (blur / pixelate) — burned into the picture so zooms cannot reveal them.
    const anns = (spec.annotations || []).map((a) => ({ ...a, start: rel(a.start ?? t0), end: rel(a.end ?? t1) })).filter((a) => a.end > a.start);
    for (const a of anns.filter((x) => x.type === 'blur' || x.type === 'pixelate')) {
      const x = Math.max(0, Math.round(a.x)), y = Math.max(0, Math.round(a.y));
      const w = even(Math.min(W - x, a.width)), h = even(Math.min(H - y, a.height));
      const [m, r, p, out] = [next(), next(), next(), next()];
      const fx = a.type === 'blur' ? `boxblur=${Math.max(2, Math.round((a.strength ?? 14) * 0.8))}:2` : `scale=${Math.max(2, Math.round(w / (a.block ?? 14)))}:${Math.max(2, Math.round(h / (a.block ?? 14)))},scale=${w}:${h}:flags=neighbor`;
      chains.push(`[${cur}]split[${m}][${r}]`, `[${r}]crop=${w}:${h}:${x}:${y},${fx}[${p}]`, `[${m}][${p}]overlay=${x}:${y}:enable='between(t,${f3(a.start)},${f3(a.end)})'[${out}]`);
      cur = out;
    }
    // 2. vector annotations, grouped by time window — one transparent overlay per window.
    const groups = new Map();
    for (const a of anns.filter((x) => x.type !== 'blur' && x.type !== 'pixelate')) {
      const k = `${f3(a.start)}-${f3(a.end)}`;
      if (!groups.has(k)) groups.set(k, { start: a.start, end: a.end, marks: [] });
      groups.get(k).marks.push(a);
    }
    let gi = 0;
    for (const g of groups.values()) {
      const file = path.join(tmp, `ann${gi++}.png`);
      await sharp(Buffer.from(marksSvg(g.marks, W, H))).png().toFile(file);
      overlayTimed(addImage(file, dur), g.start, g.end);
    }
    // 3. zooms — smooth push-in on a point, then back out.
    const zooms = (spec.zooms || []).map((z) => ({ ...z, start: rel(z.start), end: rel(z.end), scale: Math.max(1.05, Math.min(4, z.scale ?? 1.7)) }))
      .filter((z) => z.end - z.start > 0.3).sort((a, b) => a.start - b.start);
    for (let i = 1; i < zooms.length; i++) if (zooms[i].start < zooms[i - 1].end) zooms[i].start = zooms[i - 1].end;
    if (zooms.length) {
      const S = 2; // supersample so sub-pixel pans stay smooth
      const ss = (a, b) => { const u = `clip((it-${f3(a)})/${f3(Math.max(0.01, b - a))},0,1)`; return `(${u}*${u}*(3-2*${u}))`; };
      const zexpr = '1+' + zooms.map((z) => { const d = Math.min(z.ease ?? 0.55, (z.end - z.start) / 2); return `${f3(z.scale - 1)}*(${ss(z.start, z.start + d)}-${ss(z.end - d, z.end)})`; }).join('+');
      const pick = (k) => zooms.map((z) => `${f3(z[k] * S)}*between(it,${f3(z.start)},${f3(z.end)})`).join('+');
      const out = next();
      chains.push(`[${cur}]scale=${W * S}:${H * S}:flags=lanczos,zoompan=z='${zexpr}':x='clip((${pick('x')})-iw/zoom/2,0,iw-iw/zoom)':y='clip((${pick('y')})-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${W}x${H}:fps=${fps}[${out}]`);
      cur = out;
    }
    // 4/5. framed background (padding, gradient, rounded corners, soft shadow) and captions.
    // With a background, captions sit in an extra band under the picture so they never cover the product.
    const captions = (spec.captions || []).map((c) => ({ ...c, s: rel(c.start), e: rel(c.end) })).filter((c) => c.e > c.s);
    const capSize = (c) => c.size ?? Math.round(H * 0.045);
    let OW = W, OH = H;
    const addCaptions = async (cw, ch, topFor) => {
      let ci = 0;
      for (const c of captions) {
        const size = capSize(c);
        const file = path.join(tmp, `cap${ci++}.png`);
        await sharp(Buffer.from(marksSvg([{ type: 'text', text: c.text, x: cw / 2, y: topFor(size, c), anchor: 'center', size, color: c.color, background: c.background, backgroundOpacity: c.backgroundOpacity ?? 0.8 }], cw, ch, { shadow: false }))).png().toFile(file);
        overlayTimed(addImage(file, dur), c.s, c.e);
      }
    };
    if (spec.background) {
      const bg = spec.background;
      const pad = even(bg.padding ?? Math.max(W, H) * 0.05), r = bg.radius ?? 14;
      const band = captions.length ? even(Math.max(...captions.map(capSize)) * 2.4) : 0;
      OW = W + pad * 2; OH = H + pad * 2 + band;
      const blur = bg.shadowBlur ?? Math.max(8, Math.round(pad * 0.35));
      const layers = bg.shadow === false ? [] : [{ input: await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${OW}" height="${OH}"><rect x="${pad}" y="${pad + blur * 0.5}" width="${W}" height="${H}" rx="${r}" fill="#000" fill-opacity="${bg.shadowOpacity ?? 0.38}"/></svg>`)).blur(blur).png().toBuffer() }];
      const bgFile = path.join(tmp, 'bg.png'), maskFile = path.join(tmp, 'mask.png');
      await sharp(Buffer.from(backgroundSvg(OW, OH, bg))).composite(layers).png().toFile(bgFile);
      await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000"/><rect width="${W}" height="${H}" rx="${r}" fill="#fff"/></svg>`)).png().toFile(maskFile);
      const bi = addImage(bgFile, dur), mi = addImage(maskFile, dur);
      const [a, out] = [next(), next()];
      chains.push(`[${mi}:v]format=gray[mk]`, `[${cur}]format=rgba[vr]`, `[vr][mk]alphamerge[${a}]`, `[${bi}:v][${a}]overlay=${pad}:${pad}:shortest=1[${out}]`);
      cur = out;
      // Centre each caption in the band below the picture.
      await addCaptions(OW, OH, (size) => Math.round(pad + H + (pad + band) / 2 - size * 0.97 + (band ? 0 : 0)));
    } else {
      await addCaptions(W, H, (size, c) => (c.position === 'top' ? Math.round(H * 0.06) : Math.round(H * 0.94 - size * 1.9)));
    }
    // 6. speed.
    const speed = spec.speed && spec.speed > 0 ? spec.speed : 1;
    if (speed !== 1) { const out = next(); chains.push(`[${cur}]setpts=PTS/${speed}[${out}]`); cur = out; }
    // 7. intro / outro cards with cross-fade to and from black.
    const cards = [];
    for (const [key, card] of [['intro', spec.intro], ['outro', spec.outro]]) {
      if (!card) continue;
      const d = card.duration ?? 2.2, file = path.join(tmp, `${key}.png`);
      await cardPng(file, OW, OH, card);
      const idx = addImage(file, d), lbl = `${key}v`;
      chains.push(`[${idx}:v]fps=${fps},format=yuv420p,setsar=1,fade=t=in:st=0:d=0.3,fade=t=out:st=${f3(d - 0.35)}:d=0.35[${lbl}]`);
      cards.push({ key, lbl, d });
    }
    const introD = cards.find((c) => c.key === 'intro')?.d || 0;
    if (cards.length) {
      const main = next(), out = next();
      chains.push(`[${cur}]format=yuv420p,setsar=1[${main}]`);
      const seq = [cards.find((c) => c.key === 'intro')?.lbl, main, cards.find((c) => c.key === 'outro')?.lbl].filter(Boolean);
      chains.push(`${seq.map((l) => `[${l}]`).join('')}concat=n=${seq.length}:v=1:a=0[${out}]`);
      cur = out;
    }

    const args = ['-y', '-hide_banner', '-loglevel', 'error', ...inputs];
    await fs.mkdir(path.dirname(output), { recursive: true });
    if (format === 'gif') {
      const gw = Math.min(spec.width || 960, OW), gfps = spec.fps || 15;
      chains.push(`[${cur}]fps=${gfps},scale=${even(gw)}:-2:flags=lanczos,split[ga][gb]`, `[ga]palettegen=stats_mode=diff[pal]`, `[gb][pal]paletteuse=dither=sierra2_4a:diff_mode=rectangle[outv]`);
      args.push('-filter_complex', chains.join(';'), '-map', '[outv]', output);
    } else {
      let last = cur;
      if (spec.width && spec.width < OW) { chains.push(`[${cur}]scale=${even(spec.width)}:-2:flags=lanczos[outv]`); last = 'outv'; }
      const maps = ['-map', `[${last}]`];
      if (info.audioStreams && spec.audio !== false) {
        const a = Array.from({ length: info.audioStreams }, (_, i) => `[0:a:${i}]`).join('');
        const tempo = speed !== 1 ? `,atempo=${Math.max(0.5, Math.min(2, speed))}` : '';
        const delay = introD ? `,adelay=${Math.round(introD * 1000)}:all=1` : '';
        chains.push(`${a}${info.audioStreams > 1 ? `amix=inputs=${info.audioStreams}:normalize=0,` : ''}atrim=start=${f3(t0)}:end=${f3(t1)},asetpts=PTS-STARTPTS${tempo}${delay}[outa]`);
        maps.push('-map', '[outa]', '-c:a', 'aac', '-b:a', '160k');
      }
      args.push('-filter_complex', chains.join(';'), ...maps, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(spec.crf ?? 18), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);
    }
    try { await exec('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 }); }
    catch (e) { throw new Error(`ffmpeg failed: ${(e.stderr || e.message).slice(-1500)}`); }
    const res = await probe(output);
    return { file: output, format, width: res.width, height: res.height, duration: res.duration, sizeBytes: res.sizeBytes, zooms: zooms.length, annotations: anns.length };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/** Grab still frames (for an agent to look at before deciding where to annotate). */
export async function extractFrames({ input, times, outputDir }) {
  const src = expand(input);
  const dir = outputDir ? expand(outputDir) : await fs.mkdtemp(path.join(os.tmpdir(), 'demoreel-frames-'));
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (const t of times) {
    const file = path.join(dir, `frame-${f3(t).replace('.', '_')}s.png`);
    await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', f3(t), '-i', src, '-frames:v', '1', file]);
    files.push({ t, file });
  }
  return files;
}
