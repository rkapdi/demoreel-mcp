#!/usr/bin/env node
// demoreel-mcp — record, annotate and polish product demos on macOS by driving CleanShot X.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ax, sleep } from './helper.js';
import * as cs from './cleanshot.js';
import { annotateImage, GRADIENTS, PALETTE } from './annotate.js';
import { polishVideo, probe, extractFrames, zoomsFromClicks } from './video.js';
import { performActions } from './actions.js';

const exec = promisify(execFile);
const server = new McpServer({ name: 'demoreel', version: '0.1.0' });

const tool = (name, description, shape, fn) =>
  server.registerTool(name, { description, inputSchema: shape }, async (args) => {
    try {
      const result = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });

// ---------- shared schemas ----------
const Rect = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
const Target = {
  area: Rect.optional().describe('Rectangle in screen points, origin at the top-left of the main display.'),
  window: z.object({ app: z.string().optional(), bundleId: z.string().optional(), title: z.string().optional() }).optional()
    .describe('Capture the on-screen window of this app (matched by app name, bundle id and/or title substring).'),
  display: z.number().int().positive().optional().describe('Capture a whole display (1 = main). Used when neither area nor window is given.'),
};
const RecorderOptions = z.object({
  microphone: z.union([z.boolean(), z.string()]).optional().describe('true/false, or part of a device name to pick that microphone.'), systemAudio: z.boolean().optional(), camera: z.union([z.boolean(), z.string()]).optional().describe('true/false, or part of a camera name.'),
  cameraSize: z.enum(['small', 'medium', 'large', 'huge']).optional(), cameraShape: z.enum(['circle', 'square', 'rectangle', 'vertical']).optional(),
  highlightClicks: z.boolean().optional().describe('CleanShot click/cursor highlight.'), keystrokes: z.boolean().optional().describe('Show pressed keys on screen.'),
}).describe('CleanShot recorder toggles. Omitted toggles are left as the user has them.');
const Background = z.object({
  gradient: z.union([z.string(), z.array(z.string())]).optional().describe(`Preset (${Object.keys(GRADIENTS).join(', ')}) or a list of CSS colours.`),
  color: z.string().optional(), angle: z.number().optional(), padding: z.number().optional(), radius: z.number().optional(),
  shadow: z.boolean().optional(), shadowOpacity: z.number().optional(), shadowBlur: z.number().optional(),
}).describe('Frame the picture on a padded gradient with rounded corners and a soft shadow.');
const Mark = z.object({
  type: z.enum(['arrow', 'line', 'rect', 'ellipse', 'highlight', 'text', 'callout', 'step', 'spotlight', 'blur', 'pixelate']),
  x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
  from: z.tuple([z.number(), z.number()]).optional(), to: z.tuple([z.number(), z.number()]).optional(),
  target: z.tuple([z.number(), z.number()]).optional().describe('callout: the point the arrow points at.'),
  text: z.string().optional(), n: z.number().optional().describe('step: number to show (auto-increments if omitted).'),
  color: z.string().optional().describe(`Name (${Object.keys(PALETTE).join(', ')}) or any CSS colour.`),
  size: z.number().optional(), strokeWidth: z.number().optional(), radius: z.number().optional(), curve: z.number().optional().describe('arrow: bend amount, e.g. 0.2.'),
  fill: z.string().optional(), background: z.union([z.string(), z.boolean()]).optional(), anchor: z.enum(['left', 'center', 'right']).optional(),
  dim: z.number().optional().describe('spotlight: darkness of everything outside, 0–1.'), strength: z.number().optional(), block: z.number().optional(), opacity: z.number().optional(),
}).passthrough();
const TimedMark = Mark.extend({ start: z.number().optional(), end: z.number().optional() });
const Zoom = z.object({ start: z.number(), end: z.number(), x: z.number(), y: z.number(), scale: z.number().optional().describe('1.05–4, default 1.7'), ease: z.number().optional() });
const Caption = z.object({ text: z.string(), start: z.number(), end: z.number(), position: z.enum(['top', 'bottom']).optional(), size: z.number().optional(), color: z.string().optional(), background: z.string().optional() });
const Card = z.object({ title: z.string(), subtitle: z.string().optional(), duration: z.number().optional(), logo: z.string().optional(), color: z.string().optional(), background: Background.optional() });
const Step = z.object({
  do: z.enum(['move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'wait', 'activate']),
  bundleId: z.string().optional().describe('activate: app to bring to the front.'),
  x: z.number().optional(), y: z.number().optional(), to: z.tuple([z.number(), z.number()]).optional(),
  ms: z.number().optional().describe('Glide duration for pointer moves, per-character delay for type, or wait length.'),
  text: z.string().optional(), key: z.string().optional().describe('e.g. "return", "cmd+k", "shift+tab".'),
  dy: z.number().optional(), dx: z.number().optional(), pause: z.number().optional().describe('Extra pause after this step, ms.'),
  label: z.string().optional().describe('Free-text note carried into the timeline.'),
});
const PolishShape = {
  trim: z.object({ start: z.number().optional(), end: z.number().optional() }).optional(),
  speed: z.number().positive().optional(),
  zooms: z.array(Zoom).optional().describe('Smooth push-ins. Times in source seconds, x/y in source pixels (the point to centre on).'),
  annotations: z.array(TimedMark).optional().describe('Marks shown between start and end (source seconds). They are pinned to the content, so they zoom with it.'),
  captions: z.array(Caption).optional().describe('Text pinned to the frame (unaffected by zooms).'),
  background: Background.optional(), intro: Card.optional(), outro: Card.optional(),
  format: z.enum(['mp4', 'gif']).optional(), fps: z.number().optional(), width: z.number().optional().describe('Scale output down to this width.'),
  audio: z.boolean().optional(), crf: z.number().optional(),
};

// ---------- tools ----------

tool('doctor', 'Check that everything needed is in place: CleanShot X installed and running, its API reachable, Accessibility permission, ffmpeg. Run this first.', {}, async () => {
  const app = await cs.appInfo();
  const trust = await ax('trusted').catch((e) => ({ error: e.message }));
  let ffmpeg = null; try { ffmpeg = (await exec('ffmpeg', ['-version'])).stdout.split('\n')[0]; } catch {}
  const { displays } = await ax('displays').catch(() => ({ displays: [] }));
  const problems = [];
  const { prompts } = await ax('prompts').catch(() => ({ prompts: [] }));
  const notes = [];
  if (prompts.some((p) => p.visible === false)) notes.push('A macOS permission prompt is open behind another window. It will not show in captures, but answer it when you can.');
  if (prompts.some((p) => p.visible !== false)) problems.push('A macOS permission prompt is waiting on screen; it would appear in captures and can freeze the app that triggered it. Answer it.');
  const responsive = app.running ? await ax('tree', cs.BUNDLE).then(() => true, (e) => e.message) : null;
  if (typeof responsive === 'string') problems.push(`CleanShot X is not answering: ${responsive}`);
  if (!app.installed) problems.push('CleanShot X is not installed in /Applications.');
  else if (!app.running) problems.push('CleanShot X is not running — open it.');
  if (!trust.accessibility) problems.push('Accessibility permission is missing. System Settings → Privacy & Security → Accessibility → enable the app that runs this MCP server (your terminal, Claude, Cursor…). Needed to press Record/Stop and to move the pointer.');
  if (!ffmpeg) problems.push('ffmpeg not found (brew install ffmpeg). Needed for polish_video.');
  return { ok: problems.length === 0, problems, notes, cleanshot: app, permissions: trust, ffmpeg, displays,
    reminder: 'CleanShot → Settings → Advanced → API → "Allow applications to control CleanShot" must be on.' };
});

tool('cleanshot_command', `Send any official CleanShot X URL-scheme command. Commands: ${Object.keys(cs.COMMANDS).join(', ')}. Coordinates here are CleanShot-native (origin bottom-left of the chosen display); prefer screenshot/record_start, which take top-left coordinates.`,
  { command: z.string(), params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional() },
  async ({ command, params }) => ({ sent: await cs.command(command, params || {}) }));

tool('list_windows', 'List on-screen app windows with their bounds (top-left origin, points) and the displays. Use it to pick a capture target.', {},
  async () => ({ ...(await ax('windows')), ...(await ax('displays')) }));

tool('arrange_window', 'Move and resize an app window (and bring it to the front) so every take is framed identically.',
  { bundleId: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number(), title: z.string().optional().describe('Title substring when the app has several windows.') },
  async ({ bundleId, x, y, width, height, title }) => ax('set-window', bundleId, x, y, width, height, ...(title ? [title] : [])));

tool('screenshot', 'Take a screenshot with CleanShot X and return the saved file. Target an area, an app window, or a whole display. scrolling: true does an auto-scrolling capture of the area.',
  { ...Target, scrolling: z.boolean().optional().describe('Auto-scrolling capture of the area: scrolls the content to the end and stitches one tall image. Give the scrollable region itself (not the window chrome).'), scrollToTop: z.boolean().optional().describe('Scrolling capture: start from the top (default true).'), maxSeconds: z.number().optional(), cursor: z.boolean().optional(), output: z.string().optional().describe('Copy the file here.'), ignorePrompts: z.boolean().optional().describe('Capture even if a macOS permission prompt covers the area.'), keepOverlay: z.boolean().optional().describe('Leave CleanShot Quick Access Overlay items on screen (by default they are dismissed before and after every capture so they never appear in one).') },
  async ({ area, window, display, scrolling, cursor, output, keepOverlay, scrollToTop, maxSeconds, ignorePrompts }) => {
    if (!area && !window && !scrolling) return cs.screenshot({ fullscreenDisplay: display || 1, cursor, output, keepOverlay, ignorePrompts });
    return cs.screenshot({ rect: await cs.resolveArea({ area, window, display }), scrolling, output, keepOverlay, scrollToTop, maxSeconds, ignorePrompts });
  });

tool('record_start', 'Start a CleanShot X screen recording of an area, window or display. Sets the recorder toggles, presses Record, and returns once recording is live. Tip: leave microphone off for silent demos — it avoids CleanShot’s audio-merge prompt.',
  { ...Target, mode: z.enum(['video', 'gif', 'studio']).optional().describe('studio = CleanShot Studio Mode project.'), options: RecorderOptions.optional(), ignorePrompts: z.boolean().optional().describe('Capture even if a macOS permission prompt covers the area.'), keepOverlay: z.boolean().optional().describe('Leave CleanShot Quick Access Overlay items on screen (by default they are dismissed before and after every capture so they never appear in one).') },
  async ({ area, window, display, mode, options, keepOverlay, ignorePrompts }) => cs.recordStart({ rect: await cs.resolveArea({ area, window, display }), mode, options, keepOverlay, ignorePrompts }));

tool('record_stop', 'Stop the current recording, answer CleanShot’s follow-up prompts, close its editor window, and return the video file with its properties. Studio Mode recordings are exported to MP4 through CleanShot’s editor (cursor smoothing included) and the project is kept alongside.',
  { output: z.string().optional().describe('Where to save the recording (default ~/Movies/demoreel/).'), keepEditorOpen: z.boolean().optional(), exportStudio: z.boolean().optional().describe('Studio Mode: render the project to MP4 with CleanShot’s own Export and close the editor (default true). false leaves the editor open for manual editing.'), keepOverlay: z.boolean().optional().describe('Leave CleanShot Quick Access Overlay items on screen (by default they are dismissed before and after every capture so they never appear in one).') },
  async ({ keepOverlay, ...a }) => { const r = await cs.recordStop({ ...a, closeOverlay: !keepOverlay }); return /\.(mp4|mov)$/i.test(r.file) ? { ...r, video: await probe(r.file) } : r; });

tool('clear_overlays', 'Dismiss every CleanShot Quick Access Overlay item and tip bubble currently on screen. Captures stay in CleanShot’s Capture History.', {}, () => cs.clearOverlays());
tool('record_status', 'Report whether CleanShot is idle, waiting with the recorder panel open, or recording (with elapsed time).', {}, () => cs.recordStatus());
tool('record_cancel', 'Discard the recording in progress, or close the recorder panel if recording has not started.', {}, () => cs.recordCancel());

tool('perform_actions', 'Drive the Mac like a person would, for the camera: eased pointer glides, clicks, drags, smooth scrolling, typed text, shortcuts, waits. Coordinates are screen points (top-left origin), or relative to `origin` if given. Returns a timeline of clicks.',
  { steps: z.array(Step), origin: z.object({ x: z.number(), y: z.number() }).optional() },
  async ({ steps, origin }) => ({ timeline: await performActions(steps, { origin }) }));

tool('record_demo', 'One call for a whole take: (optionally) arrange the window and hide desktop icons, start recording, perform the scripted steps, stop, and (optionally) polish. Step coordinates are RELATIVE TO THE CAPTURE AREA’s top-left, in points. Returns the raw file, a click timeline in video seconds/pixels, and the polished file when `polish` is given. polish.autoZoom adds a smooth zoom on every click.',
  {
    ...Target, mode: z.enum(['video', 'gif', 'studio']).optional(), options: RecorderOptions.optional(),
    arrange: z.object({ bundleId: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number(), title: z.string().optional() }).optional(),
    hideDesktopIcons: z.boolean().optional(), ignorePrompts: z.boolean().optional().describe('Capture even if a macOS permission prompt covers the area.'), steps: z.array(Step),
    focusApp: z.string().optional().describe('Bundle id of the app to give keyboard focus once recording starts (defaults to the arranged/targeted app).'),
    leadIn: z.number().optional().describe('Quiet time before the first step, ms (default 900).'), tail: z.number().optional().describe('Quiet time after the last step, ms (default 1200).'),
    output: z.string().optional(), keepOverlay: z.boolean().optional().describe('Leave CleanShot Quick Access Overlay items on screen (by default they are dismissed before and after every capture so they never appear in one).'),
    polish: z.object({ ...PolishShape, autoZoom: z.union([z.boolean(), z.object({ scale: z.number().optional(), lead: z.number().optional(), hold: z.number().optional() })]).optional(), output: z.string().optional() }).optional(),
  },
  async (a) => {
    let arranged;
    if (a.arrange) {
      const g = a.arrange;
      const r = await ax('set-window', g.bundleId, g.x, g.y, g.width, g.height, ...(g.title ? [g.title] : []));
      arranged = { x: r.frame[0], y: r.frame[1], width: r.frame[2], height: r.frame[3] }; // what macOS actually granted
      await sleep(400);
    }
    if (a.hideDesktopIcons) await cs.command('hide-desktop-icons');
    const rect = await cs.resolveArea(arranged && !a.area && !a.window ? { area: arranged } : a);
    const started = await cs.recordStart({ rect, mode: a.mode, options: { microphone: false, ...(a.options || {}) }, keepOverlay: a.keepOverlay, ignorePrompts: a.ignorePrompts });
    let events = [], stopped;
    try {
      // CleanShot takes keyboard focus when recording starts; hand it back to the app being demoed.
      const front = a.arrange?.bundleId || a.window?.bundleId || a.focusApp;
      if (front) await ax('activate', front).catch(() => {});
      await sleep(a.leadIn ?? 900);
      events = await performActions(a.steps, { origin: rect });
      await sleep(a.tail ?? 1200);
    } finally {
      stopped = await cs.recordStop({ output: a.output, closeOverlay: !a.keepOverlay });
      if (a.hideDesktopIcons) await cs.command('show-desktop-icons').catch(() => {});
    }
    const result = { file: stopped.file, ...(stopped.project ? { project: stopped.project } : {}), area: rect, options: started.options, ...(started.warning ? { warning: started.warning } : {}) };
    if (!/\.(mp4|mov)$/i.test(stopped.file)) return { ...result, note: 'GIF recorded; timeline and polish apply to video mode only.' };
    const info = await probe(stopped.file);
    // The clip ends when Stop was pressed, so its first frame was shot `duration` earlier.
    const t0 = stopped.stoppedAt - info.duration * 1000, k = info.width / rect.width;
    const timeline = events.map((e) => ({ t: Math.max(0, Math.round((e.at - t0)) / 1000), do: e.do, ...(e.x !== undefined ? { x: Math.round(e.x * k), y: Math.round(e.y * k) } : {}), ...(e.label ? { label: e.label } : {}) }));
    Object.assign(result, { video: info, timeline });
    if (a.polish) {
      const { autoZoom, output, ...spec } = a.polish;
      const clicks = timeline.filter((e) => e.x !== undefined);
      const auto = autoZoom ? zoomsFromClicks(clicks, { ...(autoZoom === true ? {} : autoZoom), width: info.width, duration: info.duration }) : [];
      result.polished = await polishVideo({ ...spec, input: stopped.file, output, zooms: [...(spec.zooms || []), ...auto] });
    }
    return result;
  });

tool('annotate_image', 'Annotate a screenshot from a JSON list of marks — no GUI: arrows, boxes, ellipses, highlights, text labels, callouts (label + arrow), numbered steps, spotlight (dim everything else), blur and pixelate; optional crop and framed gradient background. Coordinates are image pixels (top-left origin). Set openInCleanShot to open the result in CleanShot’s Annotate window for hand-tweaks.',
  { input: z.string(), output: z.string().optional(), annotations: z.array(Mark).optional(), crop: Rect.optional(), background: Background.optional(), shadow: z.boolean().optional(), openInCleanShot: z.boolean().optional(), pin: z.boolean().optional() },
  async ({ openInCleanShot, pin, ...a }) => {
    const r = await annotateImage(a);
    if (openInCleanShot) await cs.command('open-annotate', { filepath: r.file });
    if (pin) await cs.command('pin', { filepath: r.file });
    return r;
  });

tool('polish_video', 'Post-produce a recording from a JSON spec: smooth zooms, timed annotations (same marks as annotate_image), captions, framed gradient background, intro/outro title cards, trim, speed, MP4 or GIF output. All times are seconds in the source video; all coordinates are source pixels.',
  { input: z.string(), output: z.string().optional(), ...PolishShape, clicks: z.array(z.object({ t: z.number(), x: z.number(), y: z.number() })).optional().describe('Click timeline (e.g. from record_demo) to auto-generate zooms from.'), autoZoom: z.object({ scale: z.number().optional(), lead: z.number().optional(), hold: z.number().optional() }).optional() },
  async ({ clicks, autoZoom, ...spec }) => {
    if (clicks?.length) { const info = await probe(spec.input); spec.zooms = [...(spec.zooms || []), ...zoomsFromClicks(clicks, { ...(autoZoom || {}), width: info.width, duration: info.duration })]; }
    return polishVideo(spec);
  });

tool('video_frames', 'Extract still frames from a video at given times so you can look at them (e.g. to find coordinates for annotations or check the result).',
  { input: z.string(), times: z.array(z.number()), outputDir: z.string().optional() },
  async (a) => ({ video: await probe(a.input), frames: await extractFrames(a) }));

tool('cleanshot_settings', `Read or change CleanShot X preferences. action "get" lists scalar settings; "set" writes values (a backup is taken first; verified keys: ${Object.keys(cs.VERIFIED_SETTINGS).join(', ')}); "restore" re-imports a backup (the earliest one by default).`,
  { action: z.enum(['get', 'set', 'backup', 'restore']), values: z.record(z.union([z.boolean(), z.number(), z.string()])).optional(), allowUnverified: z.boolean().optional(), file: z.string().optional() },
  async ({ action, values, allowUnverified, file }) => {
    if (action === 'get') return cs.settingsGet();
    if (action === 'backup') return { backup: await cs.settingsBackup() };
    if (action === 'restore') return cs.settingsRestore(file);
    if (!values) throw new Error('"set" needs values.');
    return cs.settingsSet(values, { allowUnverified });
  });

await server.connect(new StdioServerTransport());
