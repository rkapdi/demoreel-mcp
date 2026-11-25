// Thin wrapper around the Swift accessibility helper (helper/axhelper.swift).
// The helper is compiled on first use with `swiftc` (ships with Xcode Command Line Tools).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, '..', 'helper', 'axhelper.swift');
export const HOME = path.join(os.homedir(), '.demoreel');
const BIN = path.join(HOME, 'bin', 'axhelper');

let building;
export async function helperPath() {
  if (existsSync(BIN) && statSync(BIN).mtimeMs >= statSync(SOURCE).mtimeMs) return BIN;
  building ??= (async () => {
    mkdirSync(path.dirname(BIN), { recursive: true });
    try {
      await exec('swiftc', ['-O', SOURCE, '-o', BIN], { timeout: 180_000 });
    } catch (e) {
      throw new Error(`Could not compile the accessibility helper. Install Xcode Command Line Tools (xcode-select --install). ${e.stderr || e.message}`);
    }
    return BIN;
  })();
  try { return await building; } finally { building = undefined; }
}

/** Run a helper command and return its parsed JSON. Throws with the helper's error message. */
export async function ax(...args) {
  const bin = await helperPath();
  try {
    const { stdout } = await exec(bin, args.map(String), { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (e) {
    let msg = e.message;
    try { msg = JSON.parse(e.stdout).error; } catch {}
    throw new Error(`axhelper ${args[0]}: ${msg}`);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Depth-first search over an AX tree returned by `ax('tree', bundleId)`. */
export function* walk(tree) {
  const stack = [...tree.roots].reverse().map((n) => ({ n, parent: null }));
  while (stack.length) {
    const { n, parent } = stack.pop();
    yield { node: n, parent };
    for (const c of [...(n.children || [])].reverse()) stack.push({ n: c, parent: n });
  }
}
export function find(tree, pred) {
  for (const hit of walk(tree)) if (pred(hit.node, hit.parent)) return hit;
  return null;
}

/** Poll until fn() returns a truthy value or the timeout passes. */
export async function waitFor(fn, { timeout = 8000, interval = 250, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}

export const KEYCODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117,
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32,
  '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

/** "cmd+shift+p" -> { code, mods } */
export function parseCombo(combo) {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts.pop();
  if (!(key in KEYCODES)) throw new Error(`Unknown key "${key}". Known keys: ${Object.keys(KEYCODES).join(' ')}`);
  return { code: KEYCODES[key], mods: parts.join('+') };
}
