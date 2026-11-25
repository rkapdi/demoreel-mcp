import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import sharp from 'sharp';
import { zoomsFromClicks } from '../src/video.js';
import { marksSvg, annotateImage } from '../src/annotate.js';
import { parseCombo } from '../src/helper.js';
import { COMMANDS, VERIFIED_SETTINGS } from '../src/cleanshot.js';

test('zoomsFromClicks merges nearby clicks and separates distant ones', () => {
  const z = zoomsFromClicks([{ t: 2, x: 100, y: 100 }, { t: 2.8, x: 140, y: 110 }, { t: 6, x: 900, y: 500 }], { width: 1200, duration: 10 });
  assert.equal(z.length, 2);
  assert.ok(z[0].end >= 4.3 && z[0].start < 2);
  assert.ok(z[1].start >= z[0].end);
});

test('zoomsFromClicks clamps to the clip', () => {
  const z = zoomsFromClicks([{ t: 0.1, x: 5, y: 5 }, { t: 9.9, x: 800, y: 5 }], { width: 1000, duration: 10 });
  assert.equal(z[0].start, 0);
  assert.equal(z.at(-1).end, 10);
});

test('marksSvg renders every vector type and rejects unknown ones', () => {
  const svg = marksSvg([
    { type: 'arrow', from: [0, 0], to: [50, 50] }, { type: 'rect', x: 1, y: 1, width: 9, height: 9 },
    { type: 'callout', x: 10, y: 10, text: 'a <b>', target: [90, 90] }, { type: 'step', x: 5, y: 5 }, { type: 'step', x: 9, y: 9 },
    { type: 'spotlight', x: 0, y: 0, width: 10, height: 10 }, { type: 'highlight', x: 0, y: 0, width: 4, height: 4 },
  ], 100, 100);
  assert.match(svg, /&lt;b&gt;/);
  assert.match(svg, />1<\/text>.*>2<\/text>/s);
  assert.throws(() => marksSvg([{ type: 'sparkles' }], 10, 10), /Unknown annotation type/);
});

test('annotateImage writes a framed, annotated PNG', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'demoreel-test-'));
  const src = path.join(dir, 'in.png');
  await sharp({ create: { width: 300, height: 200, channels: 3, background: '#eee' } }).png().toFile(src);
  const r = await annotateImage({ input: src, annotations: [{ type: 'blur', x: 10, y: 10, width: 50, height: 30 }, { type: 'text', x: 20, y: 100, text: 'hi' }], background: { gradient: 'ocean', padding: 20 } });
  assert.equal(r.width, 340); assert.equal(r.height, 240);
  assert.equal((await sharp(r.file).metadata()).width, 340);
  await fs.rm(dir, { recursive: true });
});

test('parseCombo', () => {
  assert.deepEqual(parseCombo('cmd+shift+p'), { code: 35, mods: 'cmd+shift' });
  assert.deepEqual(parseCombo('Return'), { code: 36, mods: '' });
  assert.throws(() => parseCombo('cmd+nope'));
});

test('command table covers the documented API', () => {
  for (const c of ['record-screen', 'capture-area', 'scrolling-capture', 'open-annotate', 'pin', 'capture-text', 'hide-desktop-icons']) assert.ok(c in COMMANDS, c);
  assert.ok('showKeystrokes' in VERIFIED_SETTINGS);
});
