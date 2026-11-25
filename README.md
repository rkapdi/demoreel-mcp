# demoreel-mcp

An MCP server that lets an AI agent **record, annotate and polish product demo videos on macOS** by driving [CleanShot X](https://cleanshot.com).

One tool call can arrange the app window, start a CleanShot recording, move the pointer and type like a person, stop, and hand back a finished video with smooth zooms on every click, captions, a framed gradient background and title cards.

> Unofficial. Not affiliated with or endorsed by CleanShot X or MakeTheWeb. You need your own CleanShot X licence.

## Why this exists

CleanShot X has an official [URL-scheme API](https://cleanshot.com/docs-api), and other projects already wrap it. But on its own that API cannot make a demo video, because of three gaps:

| Gap in the official API | How demoreel closes it |
| --- | --- |
| **It can open the recorder but not press Record or Stop.** | A small Swift helper presses CleanShot's own buttons through the macOS Accessibility API, answers its follow-up prompts, closes its editor window and returns the file. |
| **Recorder options (mic, system audio, camera, click highlight, keystrokes) are not exposed.** | The same helper reads each toggle's state in the recorder panel and flips only the ones that differ. Other preferences can be read and written with a backup taken first. |
| **Annotation is a GUI — nothing can be drawn by command.** | A declarative renderer: describe arrows, boxes, callouts, numbered steps, spotlights, blurs in JSON and get pixels back. The same marks work on video with start/end times. |

On top of that it adds what a demo needs and CleanShot's API does not offer: scripted human-looking input, click-driven auto-zoom, captions, framed backgrounds, intro/outro cards, trim, speed, GIF export.

## Requirements

- macOS 13+ and [CleanShot X](https://cleanshot.com) 4.7+ (developed against 5.0.4), running
- CleanShot → Settings → Advanced → API → **Allow applications to control CleanShot**
- **Accessibility** permission for the app that launches the server (Claude, your terminal, Cursor…): System Settings → Privacy & Security → Accessibility
- Node.js 18+, `ffmpeg` (`brew install ffmpeg`), Xcode Command Line Tools (`xcode-select --install`) — the helper is compiled on first use

## Install

```bash
git clone <this repo> && cd demoreel-mcp && npm install
```

Claude Code:

```bash
claude mcp add demoreel -- node /absolute/path/to/demoreel-mcp/src/index.js
```

Claude Desktop / Cursor / any MCP client:

```json
{ "mcpServers": { "demoreel": { "command": "node", "args": ["/absolute/path/to/demoreel-mcp/src/index.js"] } } }
```

Then ask the agent to run the `doctor` tool. It reports anything missing.

## Tools

| Tool | What it does |
| --- | --- |
| `doctor` | Checks CleanShot, permissions, ffmpeg, displays. |
| `record_demo` | Whole take in one call: arrange window → record → scripted steps → stop → optional polish. Returns the file and a click timeline. |
| `record_start` / `record_stop` / `record_status` / `record_cancel` | Manual control of a CleanShot recording (video, GIF, or Studio Mode — Studio is experimental). |
| `perform_actions` | Eased pointer glides, clicks, drags, smooth scrolling, typing, shortcuts, waits. |
| `polish_video` | Zooms, timed annotations, captions, framed background, intro/outro, trim, speed, MP4/GIF. |
| `annotate_image` | Arrow, line, rect, ellipse, highlight, text, callout, step, spotlight, blur, pixelate; crop; framed background. Can open the result in CleanShot's Annotate or pin it. |
| `screenshot` | CleanShot capture of an area, window or display; scrolling capture. |
| `video_frames` | Stills at given times, so the agent can look before placing marks. |
| `list_windows` / `arrange_window` | Find and frame the app being demoed. |
| `cleanshot_settings` | Read, change (with backup) and restore CleanShot preferences. |
| `cleanshot_command` | Any official `cleanshot://` command, validated. |

### Coordinates

- Screen tools use **points, origin at the top-left of the main display** (the same space as window bounds). The server converts to CleanShot's bottom-left origin for you.
- In `record_demo`, step coordinates are **relative to the capture area**.
- `annotate_image` and `polish_video` use **pixels of the image / source video**. Times are **seconds in the source video**.

### Example: a full take

```json
{
  "arrange": { "bundleId": "com.apple.Safari", "x": 200, "y": 100, "width": 1200, "height": 800 },
  "options": { "highlightClicks": true, "systemAudio": false },
  "steps": [
    { "do": "click", "x": 600, "y": 196 },
    { "do": "type", "text": "Launch plan", "ms": 70, "pause": 600 },
    { "do": "click", "x": 600, "y": 445, "pause": 1500 }
  ],
  "output": "~/Movies/demo-raw.mp4",
  "polish": {
    "autoZoom": true,
    "output": "~/Movies/demo.mp4",
    "background": { "gradient": "sunrise", "padding": 48 },
    "captions": [{ "text": "Name it", "start": 0.5, "end": 4 }, { "text": "Publish in one click", "start": 4.5, "end": 9 }],
    "intro": { "title": "Acme", "subtitle": "Publishing, in ten seconds" }
  }
}
```

`examples/demo-page.html` is the page this example was tested against.

### Example: annotate a screenshot

```json
{
  "input": "shot.png",
  "annotations": [
    { "type": "pixelate", "x": 250, "y": 55, "width": 330, "height": 44 },
    { "type": "spotlight", "x": 30, "y": 140, "width": 360, "height": 220 },
    { "type": "callout", "x": 480, "y": 420, "text": "Click Publish\nto go live", "target": [900, 590], "background": "blue" },
    { "type": "step", "x": 60, "y": 160 }
  ],
  "background": { "gradient": "ocean" }
}
```

Gradient presets: `sunrise ocean violet mint peach midnight sky ember slate forest`, or pass your own list of colours.

## How it works

- `helper/axhelper.swift` — ~200 lines. Reads an app's accessibility tree as JSON, presses elements, moves/resizes windows, and posts mouse and keyboard events with easing. Compiled to `~/.demoreel/bin/axhelper` on first use.
- `src/cleanshot.js` — official URL commands, recorder control, file pickup, settings.
- `src/annotate.js` — marks → SVG → pixels via [sharp](https://sharp.pixelplumbing.com).
- `src/video.js` — builds one ffmpeg filter graph from the spec.
- `src/actions.js` — scripted input and the click timeline.

No private CleanShot APIs, no code injection, no patching: the server only opens documented URLs and presses buttons a person could press.

## Limits and notes

- **UI-driven parts can break when CleanShot changes its recorder panel.** They were verified on 5.0.4; `doctor` and clear error messages are the safety net. Please open an issue with your version if something stops matching.
- Microphone and camera are chosen from a device menu; the server clicks the menu item with the real pointer (selecting it through accessibility makes CleanShot 5.0.4 quit).
- Recording microphone **and** system audio together makes CleanShot ask about merging tracks; the server answers "Don't Merge". `record_demo` turns the microphone off unless you ask for it.
- Recordings are copied to `~/Movies/demoreel/` (or your `output`) because CleanShot deletes its temporary copy when its overlay is dismissed. The Quick Access Overlay is left alone unless you pass `closeOverlay: true`, and it can show up in screenshots taken near the screen edge it sits on.
- Studio Mode recordings produce a `.cleanshotvideo` project and leave CleanShot's editor open; exporting from that editor is not automated.
- Zooms are rendered by ffmpeg, not by CleanShot's editor. Text width for labels is estimated, so very long labels may need a `size` tweak.
- `cleanshot_settings` only writes six keys that were verified by toggling the matching control and diffing; anything else needs `allowUnverified: true`.
- The server moves your real pointer and types into the frontmost app while a script runs. Don't touch the Mac during a take.

## Development

```bash
npm test                       # unit tests (no CleanShot needed)
node test/client.mjs           # list tools
node test/client.mjs doctor    # call a tool: node test/client.mjs <tool> '<json>'
```

## Licence

MIT
