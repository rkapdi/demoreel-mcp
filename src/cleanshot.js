// CleanShot X control: official URL-scheme commands + accessibility-driven recorder control.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ax, find, walk, waitFor, sleep, HOME } from './helper.js';

const exec = promisify(execFile);
export const BUNDLE = 'pl.maketheweb.cleanshotx';
const MEDIA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'CleanShot', 'media');
const MEDIA_EXT = /\.(mp4|mov|gif|png|jpe?g|cleanshotvideo)$/i;

/** Official URL-scheme commands (https://cleanshot.com/docs-api) and the parameters each accepts. */
export const COMMANDS = {
  'all-in-one': ['x', 'y', 'width', 'height', 'display'],
  'capture-area': ['x', 'y', 'width', 'height', 'display', 'action'],
  'capture-previous-area': ['action'],
  'capture-fullscreen': ['display', 'cursor', 'action'],
  'capture-window': ['action'],
  'self-timer': ['x', 'y', 'width', 'height', 'display', 'seconds', 'cursor', 'action'],
  'scrolling-capture': ['x', 'y', 'width', 'height', 'display', 'start', 'autoscroll'],
  'pin': ['filepath'],
  'record-screen': ['x', 'y', 'width', 'height', 'display'],
  'capture-text': ['filepath', 'x', 'y', 'width', 'height', 'display', 'linebreaks'],
  'open-annotate': ['filepath'],
  'open-from-clipboard': [],
  'toggle-desktop-icons': [],
  'hide-desktop-icons': [],
  'show-desktop-icons': [],
  'add-quick-access-overlay': ['filepath'],
  'open-history': [],
  'restore-recently-closed': [],
  'open-settings': ['tab'],
};

export async function appInfo() {
  const app = '/Applications/CleanShot X.app';
  if (!existsSync(app)) return { installed: false };
  const { stdout } = await exec('defaults', ['read', `${app}/Contents/Info`, 'CFBundleShortVersionString']);
  let running = true;
  try { await exec('pgrep', ['-f', 'CleanShot X.app/Contents/MacOS']); } catch { running = false; }
  return { installed: true, version: stdout.trim(), running };
}

/** Send an official cleanshot:// command. */
export async function command(name, params = {}) {
  if (!(name in COMMANDS)) throw new Error(`Unknown CleanShot command "${name}". Valid: ${Object.keys(COMMANDS).join(', ')}`);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (!COMMANDS[name].includes(k)) throw new Error(`"${name}" does not accept "${k}". Accepts: ${COMMANDS[name].join(', ') || 'no parameters'}`);
    q.set(k, String(v));
  }
  const qs = q.toString().replace(/\+/g, '%20');
  const url = `cleanshot://${name}${qs ? `?${qs}` : ''}`;
  await exec('open', ['-g', url]);
  return url;
}

/**
 * Convert a top-left-origin rectangle in global screen points (the space window bounds and
 * mouse events use) into CleanShot's per-display, bottom-left-origin parameters.
 */
export async function toCleanShotRect(rect) {
  const { displays } = await ax('displays');
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  const d = displays.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height) || displays[0];
  return {
    x: Math.round(rect.x - d.x),
    y: Math.round(d.height - (rect.y - d.y) - rect.height),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    display: d.index,
  };
}

/** Resolve a capture target: explicit rect, an app window, or a whole display. */
export async function resolveArea({ area, window: win, display }) {
  if (area) return area;
  if (win) {
    const { windows } = await ax('windows');
    const want = (win.title || '').toLowerCase();
    const w = windows.find((x) =>
      (!win.bundleId || x.bundleId === win.bundleId) &&
      (!win.app || x.app.toLowerCase().includes(win.app.toLowerCase())) &&
      (!want || String(x.title).toLowerCase().includes(want)) && x.width > 80 && x.height > 80);
    if (!w) throw new Error(`No on-screen window matches ${JSON.stringify(win)}. Use list_windows to see what is available.`);
    return { x: w.x, y: w.y, width: w.width, height: w.height };
  }
  const { displays } = await ax('displays');
  const d = displays.find((s) => s.index === (display || 1)) || displays[0];
  return { x: d.x, y: d.y, width: d.width, height: d.height };
}

// ---------- media tracking ----------

async function listDir(dir) {
  const out = [];
  let groups = [];
  try { groups = await fs.readdir(dir); } catch { return out; }
  for (const g of groups) {
    const p = path.join(dir, g);
    let st; try { st = await fs.stat(p); } catch { continue; }
    if (st.isDirectory() && !MEDIA_EXT.test(g)) {
      for (const f of await fs.readdir(p).catch(() => [])) if (MEDIA_EXT.test(f)) out.push(path.join(p, f));
    } else if (MEDIA_EXT.test(g)) out.push(p);
  }
  return out;
}
export async function exportDir() {
  try { return (await exec('defaults', ['read', BUNDLE, 'exportPath'])).stdout.trim(); } catch { return path.join(os.homedir(), 'Desktop'); }
}
export async function mediaSnapshot() {
  return new Set([...(await listDir(MEDIA_DIR)), ...(await listDir(await exportDir()))]);
}
/** Wait for a file CleanShot created after `before` was taken, and for its size to settle. */
export async function waitForNewMedia(before, { timeout = 30000, ext } = {}) {
  let last = null, lastSize = -1, stable = 0;
  return waitFor(async () => {
    const now = [...(await mediaSnapshot())].filter((f) => !before.has(f) && (!ext || ext.test(f)));
    if (!now.length) return null;
    const stats = await Promise.all(now.map(async (f) => ({ f, st: await fs.stat(f).catch(() => null) })));
    const newest = stats.filter((s) => s.st).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0];
    if (!newest) return null;
    if (newest.f === last && newest.st.size === lastSize && newest.st.size > 0) stable++; else stable = 0;
    last = newest.f; lastSize = newest.st.size;
    return stable >= 2 ? newest.f : null;
  }, { timeout, interval: 400, what: 'CleanShot to write the capture file' });
}
/** Copy the capture out of CleanShot's temporary media folder (it is removed when its overlay is closed). */
async function deliver(file, output) {
  const dest = output
    ? path.resolve(output.replace(/^~(?=\/)/, os.homedir()))
    : path.join(os.homedir(), 'Movies', 'demoreel', path.basename(file).replace(/^CleanShot /, '').replace(/\s+/g, '-'));
  if (dest === file || !file.startsWith(MEDIA_DIR) && !output) return file;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(file, dest, { recursive: true });
  return dest;
}

// ---------- recorder (accessibility) ----------

const tree = () => ax('tree', BUNDLE);
const TOGGLES = { microphone: 'recorderMicrophone', systemAudio: 'recorderSystemSound', camera: 'recorderCamera', highlightClicks: 'recorderHighlightCursor', keystrokes: 'recorderShowKeystrokes' };
const RECORD_BUTTON = { video: 'Record Video', gif: 'Record GIF', studio: 'Record in Studio Mode' };
const isTimer = (n) => n.role === 'AXStaticText' && /^\d+:\d\d(:\d\d)?$/.test(n.value || '');

/** The recorder options panel shown after `record-screen` (before recording starts). */
function readPanel(t) {
  const start = find(t, (n) => n.role === 'AXButton' && n.title === 'Record Video');
  if (!start) return null;
  const panel = start.parent;
  const kids = panel.children || [];
  const toggles = {};
  for (const [name, desc] of Object.entries(TOGGLES)) {
    const i = kids.findIndex((k) => k.role === 'AXImage' && k.desc === desc);
    if (i > 0 && kids[i - 1].role === 'AXButton') {
      // CleanShot nudges the icon up by a few points when the option is on.
      toggles[name] = { path: kids[i - 1].path, on: kids[i].frame[1] < kids[i - 1].frame[1] };
    }
  }
  const buttons = Object.fromEntries(Object.entries(RECORD_BUTTON).map(([m, title]) => [m, kids.find((k) => k.title === title)?.path]));
  return { toggles, buttons };
}
/** The small control strip shown while a recording is in progress: [stop+timer] [pause] [restart] [trash]. */
function readControls(t) {
  for (const root of t.roots) {
    const kids = root.children || [];
    const timer = kids.find(isTimer);
    if (!timer || root.frame[3] > 120) continue; // the strip is a short bar; the editor also shows times
    if (find(t, (n) => n.title === 'Record Video')) return null; // panel still open → not recording yet
    const buttons = kids.filter((k) => k.role === 'AXButton');
    return { elapsed: timer.value, stop: buttons[0]?.path, pause: buttons[1]?.path, restart: buttons[2]?.path, trash: buttons[3]?.path };
  }
  return null;
}

const STATE = path.join(HOME, 'recording.json');
async function saveState(s) { await fs.mkdir(HOME, { recursive: true }); await fs.writeFile(STATE, JSON.stringify(s)); }
async function loadState() { try { return JSON.parse(await fs.readFile(STATE, 'utf8')); } catch { return null; } }

export async function recordStatus() {
  const t = await tree();
  const c = readControls(t);
  if (c) return { state: 'recording', elapsed: c.elapsed };
  if (readPanel(t)) return { state: 'ready', note: 'Recorder panel is open; recording has not started.' };
  return { state: 'idle' };
}

/**
 * Start a recording. `rect` is top-left-origin global points.
 * options: { microphone, systemAudio, camera, highlightClicks, keystrokes } — booleans; omitted keys are left as they are.
 */
export async function recordStart({ rect, mode = 'video', options = {} }) {
  if (readControls(await tree())) throw new Error('A CleanShot recording is already in progress. Call record_stop first.');
  const before = [...(await mediaSnapshot())];
  const cs = await toCleanShotRect(rect);
  await command('record-screen', cs);
  let panel = await waitFor(async () => readPanel(await tree()), { timeout: 10000, what: 'the CleanShot recorder panel (is "Allow applications to control CleanShot" enabled in Settings → Advanced → API?)' });

  const applied = {};
  for (const [name, want] of Object.entries(options)) {
    if (typeof want !== 'boolean' && typeof want !== 'string') continue;
    const tg = panel.toggles[name];
    if (!tg) { applied[name] = 'unavailable'; continue; }
    const on = want !== false;
    // A string picks a device by name (microphone / camera), so always open the menu for it.
    if (tg.on !== on || typeof want === 'string') {
      await ax('press', BUNDLE, tg.path);
      await sleep(400);
      // Microphone and camera open a device menu instead of flipping straight away.
      const menu = find(await tree(), (n, parent) => n.role === 'AXMenu' && parent?.role === 'AXWindow');
      if (menu) {
        const items = (menu.node.children || []).filter((i) => i.title);
        const off = items.find((i) => /^(do not|don.t|no |none)/i.test(i.title));
        const pick = !on ? off
          : (typeof want === 'string' && items.find((i) => i.title.toLowerCase().includes(want.toLowerCase()))) || items.find((i) => i !== off);
        // A real click: pressing these menu items through accessibility makes CleanShot 5.0.4 quit.
        if (pick) await ax('click', pick.frame[0] + pick.frame[2] / 2, pick.frame[1] + pick.frame[3] / 2, 200); else await ax('key', 53);
        await sleep(400);
      }
      panel = await waitFor(async () => readPanel(await tree()), { timeout: 4000, what: 'the recorder panel' });
    }
    applied[name] = panel.toggles[name]?.on ?? on;
  }
  const btn = panel.buttons[mode];
  if (!btn) throw new Error(`CleanShot does not offer "${RECORD_BUTTON[mode]}" in this version.`);
  await ax('press', BUNDLE, btn);
  const pressedAt = Date.now();
  // The timer strip appears straight away; it starts counting when the countdown (if any) ends.
  await waitFor(async () => readControls(await tree()), { timeout: 15000, what: 'the recording to start' });
  await saveState({ before, rect, mode, pressedAt });
  return { state: 'recording', mode, area: rect, cleanshotArea: cs, options: applied, startedAt: pressedAt };
}

/** Stop the current recording, dismiss CleanShot's follow-up dialogs, and return the file. */
export async function recordStop({ output, keepEditorOpen = false, closeOverlay = false } = {}) {
  const state = await loadState();
  const c = readControls(await tree());
  if (!c) throw new Error('No CleanShot recording is in progress.');
  await ax('press', BUNDLE, c.stop);
  const stoppedAt = Date.now();
  const before = new Set(state?.before || []);
  const mode = state?.mode || 'video';
  const ext = mode === 'gif' ? /\.gif$/i : mode === 'studio' ? /\.cleanshotvideo$/i : /\.(mp4|mov)$/i;

  // CleanShot may ask about merging microphone + system audio; answer "Don't Merge" (keeps both tracks).
  const dismiss = async () => {
    const t = await tree();
    const sheet = find(t, (n) => n.role === 'AXButton' && n.id === 'action-button-1');
    const ask = sheet || find(t, (n) => n.role === 'AXButton' && n.title === "Don't Merge");
    if (ask) { await ax('press', BUNDLE, ask.node.path).catch(() => {}); return true; }
    return false;
  };
  let file;
  const deadline = Date.now() + 60000;
  while (!file) {
    await dismiss();
    file = await waitForNewMedia(before, { timeout: 2500, ext }).catch(() => null);
    if (!file && Date.now() > deadline) throw new Error('Recording stopped, but CleanShot did not produce a file within 60 s.');
  }
  await sleep(600);
  for (let i = 0; i < 3 && (await dismiss()); i++) await sleep(600);

  const delivered = await deliver(file, output);
  let closed = [];
  if (!keepEditorOpen && mode !== 'studio') closed = await tidy(path.basename(file), { closeOverlay });
  await fs.rm(STATE, { force: true });
  return { file: delivered, original: file, mode, area: state?.rect, pressedAt: state?.pressedAt, stoppedAt, closed };
}

/**
 * Close the editor window CleanShot opens after a capture. With closeOverlay, also dismiss the
 * newest Quick Access Overlay item (CleanShot then deletes its temporary copy — ours is already saved).
 */
export async function tidy(filename, { settle = 3000, closeOverlay = false } = {}) {
  const closed = new Set();
  const end = Date.now() + settle;
  // The windows can appear a moment after the file is written, so sweep for a few seconds.
  do {
    const t = await tree();
    for (const root of t.roots) {
      if (root.role !== 'AXWindow') continue;
      const kids = root.children || [];
      if (filename && root.title && root.title.includes(filename)) {
        const close = kids.find((k) => k.subrole === 'AXCloseButton');
        if (close) { await ax('press', BUNDLE, close.path).catch(() => {}); closed.add('editor'); break; }
      } else if (closeOverlay && kids.some((k) => /want to close this/i.test(k.value || ''))) {
        const ok = kids.find((k) => k.role === 'AXButton' && k.title === 'Close');
        if (ok) { await ax('press', BUNDLE, ok.path).catch(() => {}); closed.add('overlay'); break; }
      } else if (closeOverlay && !closed.has('overlay-x') && kids.some((k) => k.role === 'AXButton' && k.title === 'Save') && kids.some((k) => /^popup/i.test(k.desc || ''))) {
        // The untitled button nearest the item's top-left corner is its close button.
        const btns = kids.filter((k) => k.role === 'AXButton' && !k.title).sort((a, b) => (a.frame[0] + a.frame[1]) - (b.frame[0] + b.frame[1]));
        if (btns[0]) { await ax('press', BUNDLE, btns[0].path).catch(() => {}); closed.add('overlay-x'); break; }
      }
    }
    await sleep(400);
  } while (Date.now() < end);
  closed.delete('overlay-x');
  return [...closed];
}

export async function recordCancel() {
  const t = await tree();
  const c = readControls(t);
  if (c?.trash) { await ax('press', BUNDLE, c.trash); await sleep(500); const b = find(await tree(), (n) => n.role === 'AXButton' && /delete|discard|trash/i.test(n.title || '')); if (b) await ax('press', BUNDLE, b.node.path); return { cancelled: 'recording' }; }
  if (readPanel(t)) { await ax('key', 53); return { cancelled: 'panel' }; }
  return { cancelled: null };
}

// ---------- screenshots ----------

export async function screenshot({ rect, fullscreenDisplay, cursor, output, scrolling = false, autoscroll = true }) {
  const before = await mediaSnapshot();
  if (scrolling) {
    await command('scrolling-capture', { ...(await toCleanShotRect(rect)), start: true, autoscroll });
  } else if (fullscreenDisplay) {
    await command('capture-fullscreen', { display: fullscreenDisplay, cursor, action: 'save' });
  } else {
    await command('capture-area', { ...(await toCleanShotRect(rect)), action: 'save' });
  }
  const file = await waitForNewMedia(before, { timeout: scrolling ? 120000 : 15000, ext: /\.(png|jpe?g)$/i });
  return { file: await deliver(file, output), original: file };
}

// ---------- settings (defaults) ----------

/** Preference keys confirmed against CleanShot 5.0.x by toggling the matching control and diffing. */
export const VERIFIED_SETTINGS = {
  showKeystrokes: 'bool', highlightClicks: 'bool', recordComputerAudio: 'bool',
  doNotDisturbWhileRecording: 'bool', captureWithoutDesktopIcons: 'bool', screenshotSound: 'bool',
};
const SENSITIVE = /licen|token|email|serial|user|key$|legit|^s\d{3}$|^MGR|^SU|bookmark|^NS/i;

export async function settingsGet() {
  // Scalar settings only: CleanShot also stores binary blobs (shortcuts, history) that are of no use here.
  const { stdout } = await exec('defaults', ['read', BUNDLE]);
  const all = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^ {4}"?([A-Za-z_0-9]+)"? = (?:"(.*)"|(-?[0-9.]+)|([A-Za-z/._-]+));$/);
    if (!m || SENSITIVE.test(m[1])) continue;
    all[m[1]] = m[3] !== undefined ? Number(m[3]) : (m[2] ?? m[4]);
  }
  return all;
}
export async function settingsBackup() {
  const dir = path.join(HOME, 'backups');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `cleanshot-${new Date().toISOString().replace(/[:.]/g, '-')}.plist`);
  await exec('defaults', ['export', BUNDLE, file]);
  return file;
}
export async function settingsSet(values, { allowUnverified = false } = {}) {
  const backup = await settingsBackup();
  const applied = {};
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k) || SENSITIVE.test(k)) throw new Error(`Refusing to write setting "${k}".`);
    if (!(k in VERIFIED_SETTINGS) && !allowUnverified) throw new Error(`"${k}" is not a verified setting (${Object.keys(VERIFIED_SETTINGS).join(', ')}). Pass allowUnverified: true to write it anyway.`);
    const flag = typeof v === 'boolean' ? ['-bool', String(v)] : Number.isInteger(v) ? ['-int', String(v)] : typeof v === 'number' ? ['-float', String(v)] : ['-string', String(v)];
    await exec('defaults', ['write', BUNDLE, k, ...flag]);
    applied[k] = v;
  }
  return { applied, backup, note: 'Changes apply the next time the recorder or capture tool opens.' };
}
export async function settingsRestore(file) {
  const dir = path.join(HOME, 'backups');
  const target = file || (await fs.readdir(dir)).filter((f) => f.endsWith('.plist')).sort().map((f) => path.join(dir, f))[0];
  if (!target) throw new Error('No settings backup found.');
  await exec('defaults', ['import', BUNDLE, target]);
  return { restored: target, note: 'Restart CleanShot X for every restored value to take effect.' };
}
