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

/**
 * CleanShot reads `filepath` itself, and macOS blocks it behind a permission prompt for files in
 * Desktop, Documents or Downloads (the app hangs until the user answers). Hand it a copy from a
 * folder that needs no permission instead.
 */
export async function handoff(file) {
  const src = path.resolve(String(file).replace(/^~(?=\/)/, os.homedir()));
  const dir = path.join(HOME, 'handoff');
  if (src.startsWith(dir) || src.startsWith(MEDIA_DIR)) return src;
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, path.basename(src));
  await fs.copyFile(src, dest);
  return dest;
}

/** Send an official cleanshot:// command. */
export async function command(name, params = {}) {
  if (!(name in COMMANDS)) throw new Error(`Unknown CleanShot command "${name}". Valid: ${Object.keys(COMMANDS).join(', ')}`);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (!COMMANDS[name].includes(k)) throw new Error(`"${name}" does not accept "${k}". Accepts: ${COMMANDS[name].join(', ') || 'no parameters'}`);
    q.set(k, String(k === 'filepath' ? await handoff(v) : v));
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

/**
 * macOS permission prompts float above everything and get captured. Refuse to capture through one
 * that covers the area; report any others so the caller can tell the user.
 */
export async function checkPrompts(rect, { ignorePrompts = false } = {}) {
  const { prompts } = await ax('prompts');
  if (!prompts.length) return {};
  const hit = (p) => !rect || (p.x < rect.x + rect.width && p.x + p.width > rect.x && p.y < rect.y + rect.height && p.y + p.height > rect.y);
  if (!ignorePrompts && prompts.some(hit)) {
    throw new Error('A macOS permission prompt is on screen inside the capture area and would appear in the capture. Answer it (Allow or Don’t Allow) and try again, or pass ignorePrompts: true.');
  }
  return { warning: 'A macOS permission prompt is on screen. It is outside the capture area, but answer it before the next take.' };
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
    return { frame: root.frame, elapsed: timer.value, stop: buttons[0]?.path, pause: buttons[1]?.path, restart: buttons[2]?.path, trash: buttons[3]?.path };
  }
  return null;
}

const stripFrame = (t) => t.roots.find((r) => r.frame[3] <= 120 && (r.children || []).some(isTimer))?.frame.join() ?? '';
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
export async function recordStart({ rect, mode = 'video', options = {}, keepOverlay = false, ignorePrompts = false }) {
  if (readControls(await tree())) throw new Error('A CleanShot recording is already in progress. Call record_stop first.');
  const promptNote = await checkPrompts(rect, { ignorePrompts });
  if (!keepOverlay) await clearOverlays();
  const before = [...(await mediaSnapshot())];
  const cs = await toCleanShotRect(rect);
  await command('record-screen', cs);
  let panel = await waitFor(async () => readPanel(await tree()), { timeout: 10000, what: 'the CleanShot recorder panel (is "Allow applications to control CleanShot" enabled in Settings → Advanced → API?)' });

  // Microphone and camera open a menu instead of flipping. Returns the menu's titled items, with separators as null.
  const openMenu = async (name) => {
    await ax('press', BUNDLE, panel.toggles[name].path);
    await sleep(400);
    const menu = find(await tree(), (n, parent) => n.role === 'AXMenu' && parent?.role === 'AXWindow');
    return menu ? (menu.node.children || []).map((i) => (i.title ? i : null)) : null;
  };
  // A real click: pressing these menu items through accessibility makes CleanShot 5.0.4 quit.
  const choose = async (item) => {
    if (item) await ax('click', item.frame[0] + item.frame[2] / 2, item.frame[1] + item.frame[3] / 2, 200); else await ax('key', 53);
    await sleep(450);
    panel = await waitFor(async () => readPanel(await tree()), { timeout: 4000, what: 'the recorder panel' });
  };
  const applied = {};
  for (const [name, want] of Object.entries(options)) {
    if (!(name in TOGGLES) || (typeof want !== 'boolean' && typeof want !== 'string')) continue;
    const tg = panel.toggles[name];
    if (!tg) { applied[name] = 'unavailable'; continue; }
    const on = want !== false;
    // A string picks a device by name (microphone / camera), so always open the menu for it.
    if (tg.on !== on || typeof want === 'string') {
      const items = await openMenu(name);
      if (items) {
        const offAt = items.findIndex((i) => i && /^(do not|don.t|none)/i.test(i.title));
        // Devices are the entries right after the "off" entry, up to the next separator.
        const devices = [];
        for (let i = offAt + 1; i < items.length; i++) { if (items[i]) devices.push(items[i]); else if (devices.length) break; }
        const pick = !on ? items[offAt]
          : (typeof want === 'string' && devices.find((d) => d.title.toLowerCase().includes(want.toLowerCase())))
            // Prefer the Mac's own device: picking an iPhone would wake the phone.
            || devices.find((d) => /facetime|built-?in|macbook|imac|studio display/i.test(d.title)) || devices[0];
        if (on && !pick) { await choose(null); throw new Error(`No ${name} device found${typeof want === 'string' ? ` matching "${want}"` : ''}.`); }
        await choose(pick);
        if (pick && on) applied[`${name}Device`] = pick.title;
      } else {
        panel = await waitFor(async () => readPanel(await tree()), { timeout: 4000, what: 'the recorder panel' });
      }
    }
    applied[name] = panel.toggles[name]?.on ?? on;
  }
  // Camera bubble size and shape live in the same menu.
  for (const [key, re] of [['cameraSize', /^(small|medium|large|huge)$/i], ['cameraShape', /^(circle|square|rectangle|vertical)$/i]]) {
    const want = options[key];
    if (!want || !panel.toggles.camera) continue;
    if (!re.test(want)) throw new Error(`Invalid ${key} "${want}".`);
    const items = await openMenu('camera');
    const item = items?.find((i) => i && i.title.toLowerCase() === String(want).toLowerCase());
    await choose(item || null);
    applied[key] = item ? item.title : 'unavailable';
  }
  const btn = panel.buttons[mode];
  if (!btn) throw new Error(`CleanShot does not offer "${RECORD_BUTTON[mode]}" in this version.`);
  const stripBefore = stripFrame(await tree());
  // If CleanShot answers with a modal alert, the press itself reports "cannot complete".
  await ax('press', BUNDLE, btn).catch(() => {});
  const pressedAt = Date.now();
  await waitFor(async () => {
    const t = await tree();
    const alert = t.roots.find((r) => r.desc === 'alert');
    if (alert) {
      const kids = alert.children || [];
      // "Camera is on but no microphone is selected" — carry on without sound.
      const ok = kids.find((k) => k.role === 'AXButton' && /^don.t record audio$/i.test(k.title || ''));
      if (ok) { await ax('press', BUNDLE, ok.path).catch(() => {}); applied.audioPrompt = "answered: Don't Record Audio"; return false; }
      const text = kids.filter((k) => k.role === 'AXStaticText').map((k) => k.value).join(' — ');
      const cancel = kids.find((k) => k.role === 'AXButton' && k.title === 'Cancel');
      if (cancel) await ax('press', BUNDLE, cancel.path).catch(() => {});
      throw new Error(`CleanShot refused to start: ${text}`);
    }
    const c = readControls(t);
    // The strip exists before recording too; it has started once the strip moved or the clock runs.
    return c && (c.frame.join() !== stripBefore || c.elapsed !== '0:00');
  }, { timeout: 20000, what: 'the recording to start' });
  await saveState({ before, rect, mode, pressedAt });
  return { state: 'recording', mode, area: rect, cleanshotArea: cs, options: applied, startedAt: pressedAt, ...promptNote };
}

/** Stop the current recording, dismiss CleanShot's follow-up dialogs, and return the file. */
export async function recordStop({ output, keepEditorOpen = false, closeOverlay = true, exportStudio = true } = {}) {
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

  let delivered = await deliver(file, output && mode === 'studio' ? output.replace(/\.(mp4|mov)$/i, '.cleanshotvideo') : output);
  const extra = {};
  const stem = path.basename(file).replace(/\.[a-z]+$/i, '');
  if (mode === 'studio' && exportStudio) {
    // Studio Mode leaves a project open in CleanShot's editor; render it with the editor's own Export.
    const beforeExport = await mediaSnapshot();
    const exportBtn = await waitFor(async () => {
      const t = await tree();
      const win = t.roots.find((r) => r.role === 'AXWindow' && r.title && r.title.includes(stem));
      return win && find({ roots: [win] }, (n) => n.role === 'AXButton' && n.title === 'Export');
    }, { timeout: 15000, what: 'the Studio editor' });
    await ax('press', BUNDLE, exportBtn.node.path);
    await waitFor(async () => find(await tree(), (n) => n.role === 'AXPopUpButton' && /\d+\s*×\s*\d+/.test(n.value || '')), { timeout: 8000, what: 'the export options' });
    await ax('activate', BUNDLE).catch(() => {});
    await ax('key', 36); // Return = the popover's default "Export" button, which accessibility does not expose
    const rendered = await waitForNewMedia(beforeExport, { timeout: 10 * 60_000, ext: /\.(mp4|mov)$/i });
    extra.project = delivered;
    delivered = await deliver(rendered, output ? output.replace(/\.cleanshotvideo$/i, '.mp4') : undefined);
  } else if (mode === 'studio') {
    extra.note = 'Studio project saved; CleanShot’s editor is still open for manual editing and export.';
  }
  let closed = [];
  if (!keepEditorOpen && !(mode === 'studio' && !exportStudio)) closed = await tidy(stem, { closeOverlay });
  await fs.rm(STATE, { force: true });
  return { file: delivered, original: file, mode, ...extra, area: state?.rect, pressedAt: state?.pressedAt, stoppedAt, closed };
}

const isOverlayItem = (root) => root.role === 'AXWindow' && (root.children || []).some((k) => (k.role === 'AXImage' && /^popup/i.test(k.desc || '')) || (k.role === 'AXButton' && k.title === 'Save'));
const isTip = (root) => (root.children || []).some((k) => k.role === 'AXButton' && k.title === 'Got it!');
const closeAlert = (root) => (root.children || []).some((k) => /are you sure you want to close/i.test(k.value || '')) && (root.children || []).find((k) => k.role === 'AXButton' && k.title === 'Close');

/**
 * Dismiss every Quick Access Overlay item (and tip bubble) so none can end up in a capture.
 * CleanShot keeps dismissed captures in its Capture History, and `restore-recently-closed`
 * brings the last one back.
 */
export async function clearOverlays({ max = 12 } = {}) {
  const count = async () => (await tree()).roots.filter(isOverlayItem).length;
  const before = await count();
  let hovered = false;
  for (let i = 0; i < max * 3; i++) {
    const t = await tree();
    const confirm = t.roots.map(closeAlert).find(Boolean);
    if (confirm) { await ax('press', BUNDLE, confirm.path).catch(() => {}); await sleep(450); continue; }
    const tip = t.roots.find(isTip);
    if (tip) { await ax('press', BUNDLE, tip.children.find((k) => k.title === 'Got it!').path).catch(() => {}); await sleep(350); continue; }
    const item = t.roots.find(isOverlayItem);
    if (!item) break;
    // The untitled button nearest the item's top-left corner is its close button.
    const btns = item.children.filter((k) => k.role === 'AXButton' && !k.title).sort((a, b) => (a.frame[0] + a.frame[1]) - (b.frame[0] + b.frame[1]));
    if (btns[0]) {
      // This press opens a modal confirmation, so the call itself reports "cannot complete" — expected.
      await ax('press', BUNDLE, btns[0].path).catch(() => {});
      await sleep(500);
    } else if (!hovered) {
      // Buttons only exist while the pointer is over the item.
      const img = item.children.find((k) => k.role === 'AXImage') || item.children[0];
      await ax('move', img.frame[0] + 40, img.frame[1] - 40, 250);
      hovered = true;
      await sleep(400);
    } else break;
  }
  const remaining = await count();
  return { dismissed: Math.max(0, before - remaining), remaining };
}

/** Close the editor window CleanShot opens after a capture (optionally the overlay too). */
export async function tidy(filename, { settle = 3000, closeOverlay = true } = {}) {
  const closed = [];
  const end = Date.now() + settle;
  // The editor can appear a moment after the file is written, so sweep for a few seconds.
  do {
    const t = await tree();
    // Video editor (titled with the file name) or the GIF trimmer (titled "CleanShot", has a Trim button).
    const editor = t.roots.find((r) => r.role === 'AXWindow' && ((filename && r.title && r.title.includes(filename)) || (r.children || []).some((k) => k.role === 'AXButton' && k.title === 'Trim')));
    const close = editor && (editor.children || []).find((k) => k.subrole === 'AXCloseButton');
    if (close) {
      // A Studio project asks whether to save first, so the press reports "cannot complete".
      await ax('press', BUNDLE, close.path).catch(() => {});
      await sleep(600);
      const discard = find(await tree(), (n) => n.role === 'AXButton' && n.title === 'Close Project');
      if (discard) await ax('press', BUNDLE, discard.node.path).catch(() => {});
      closed.push('editor');
    }
    await sleep(400);
  } while (Date.now() < end && !closed.length);
  if (closeOverlay) { const r = await clearOverlays(); if (r.dismissed) closed.push('overlay'); }
  return closed;
}

export async function recordCancel() {
  const confirmDelete = async () => {
    const b = find(await tree(), (n) => n.role === 'AXButton' && n.title === 'Delete');
    if (b) { await ax('press', BUNDLE, b.node.path); return true; }
    return false;
  };
  if (await confirmDelete()) { await fs.rm(STATE, { force: true }); return { cancelled: 'recording' }; }
  const t = await tree();
  const c = readControls(t);
  if (c?.trash) {
    // Opens a modal "delete this recording?" alert, so the press itself reports "cannot complete".
    await ax('press', BUNDLE, c.trash).catch(() => {});
    await waitFor(confirmDelete, { timeout: 5000, what: 'CleanShot’s delete confirmation' });
    await waitFor(async () => !readControls(await tree()), { timeout: 5000, what: 'the recording to be discarded' });
    await fs.rm(STATE, { force: true });
    return { cancelled: 'recording' };
  }
  if (readPanel(t)) {
    // Escape goes to the frontmost app, so make sure that is CleanShot's panel, and allow it a moment to close.
    for (let i = 0; i < 3; i++) {
      await ax('key', 53);
      const gone = await waitFor(async () => !readPanel(await tree()), { timeout: 2000 }).catch(() => false);
      if (gone) return { cancelled: 'panel' };
    }
    throw new Error('Could not close the recorder panel; press Escape.');
  }
  return { cancelled: null };
}

// ---------- screenshots ----------

/** Position (0–1) of the vertical scrollbar under `rect` in the app that owns it, or null if the app exposes none. */
async function scrollPosition(bundleId, rect) {
  if (!bundleId) return null;
  const t = await ax('tree', bundleId).catch(() => null);
  if (!t) return null;
  let best = null;
  for (const { node: n } of walk(t)) {
    if (n.role !== 'AXScrollBar' || n.frame[3] <= n.frame[2]) continue; // vertical bars only
    const [x, , w] = n.frame;
    if (x + w < rect.x || x > rect.x + rect.width + 30) continue;
    if (!best || n.frame[3] > best.frame[3]) best = n;
  }
  const v = best ? Number(best.value) : NaN;
  return Number.isFinite(v) ? v : null;
}

/**
 * Scrolling capture: CleanShot scrolls the content under the pointer and stitches it; it never
 * finishes on its own, so we watch the target's scrollbar and press Done when it reaches the end.
 */
async function scrollingCapture({ rect, scrollToTop = true, maxSeconds = 60, scrollSeconds = 10 }) {
  const cx = Math.round(rect.x + rect.width / 2), cy = Math.round(rect.y + rect.height / 2);
  const { windows } = await ax('windows');
  const owner = windows.find((w) => cx >= w.x && cx < w.x + w.width && cy >= w.y && cy < w.y + w.height && w.bundleId !== BUNDLE)?.bundleId;
  if (owner) await ax('activate', owner).catch(() => {});
  await ax('move', cx, cy, 300);
  if (scrollToTop) {
    for (let i = 0; i < 12 && (await scrollPosition(owner, rect)) !== 0; i++) await ax('scroll', 40);
    await sleep(500);
  }
  await command('scrolling-capture', { ...(await toCleanShotRect(rect)), start: true, autoscroll: true });
  const done = () => tree().then((t) => find(t, (n, parent) => n.role === 'AXButton' && n.title === 'Done' && (parent?.children || []).some((k) => k.title === 'Cancel')));
  await waitFor(done, { timeout: 10000, what: 'the scrolling capture to start' });
  // Auto-scroll begins once the pointer is inside the area.
  await ax('move', cx + 12, cy + 12, 250);
  const started = Date.now();
  let last = await scrollPosition(owner, rect), lastChange = Date.now(), moved = false;
  const tracked = last !== null;
  while (Date.now() - started < maxSeconds * 1000) {
    await sleep(500);
    if (!tracked) { if (Date.now() - started > scrollSeconds * 1000) break; continue; }
    const v = await scrollPosition(owner, rect);
    if (v !== null && v !== last) { last = v; lastChange = Date.now(); moved = true; }
    if (v !== null && v >= 0.999) { await sleep(900); break; }
    if (Date.now() - lastChange > (moved ? 2500 : 5000)) break; // stalled, or content does not scroll
  }
  const btn = await done();
  if (!btn) throw new Error('The scrolling capture ended before it could be finished.');
  await ax('press', BUNDLE, btn.node.path);
  return { tracked, reachedEnd: tracked ? last >= 0.999 : undefined };
}

export async function screenshot({ rect, fullscreenDisplay, cursor, output, scrolling = false, keepOverlay = false, scrollToTop, maxSeconds, scrollSeconds, ignorePrompts = false }) {
  const promptNote = await checkPrompts(rect, { ignorePrompts });
  if (!keepOverlay) await clearOverlays();
  const before = await mediaSnapshot();
  let extra = {};
  if (scrolling) extra = { scroll: await scrollingCapture({ rect, scrollToTop, maxSeconds, scrollSeconds }) };
  else if (fullscreenDisplay) await command('capture-fullscreen', { display: fullscreenDisplay, cursor, action: 'save' });
  else await command('capture-area', { ...(await toCleanShotRect(rect)), action: 'save' });
  const file = await waitForNewMedia(before, { timeout: 20000, ext: /\.(png|jpe?g)$/i });
  const delivered = await deliver(file, output);
  if (!keepOverlay) { await sleep(500); await clearOverlays(); }
  const meta = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', delivered]).then((r) => r.stdout.match(/\d+$/gm)?.map(Number)).catch(() => null);
  return { file: delivered, original: file, ...(meta ? { width: meta[0], height: meta[1] } : {}), ...extra, ...promptNote };
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
  for (const k of Object.keys(values)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k) || SENSITIVE.test(k)) throw new Error(`Refusing to write setting "${k}".`);
    if (!(k in VERIFIED_SETTINGS) && !allowUnverified) throw new Error(`"${k}" is not a verified setting (${Object.keys(VERIFIED_SETTINGS).join(', ')}). Pass allowUnverified: true to write it anyway.`);
  }
  const backup = await settingsBackup();
  const applied = {};
  for (const [k, v] of Object.entries(values)) {
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
