// Scripted, human-looking input: eased cursor glides, clicks, typing, scrolling.
import { ax, sleep, parseCombo } from './helper.js';

/**
 * Run steps in order. Coordinates are global screen points, offset by `origin` when given
 * (pass the capture area's top-left so steps can be written relative to the recording).
 * Returns a timeline of what happened and when (epoch ms).
 */
export async function performActions(steps, { origin = { x: 0, y: 0 } } = {}) {
  const timeline = [];
  const X = (v) => Math.round(v + origin.x), Y = (v) => Math.round(v + origin.y);
  for (const [i, s] of steps.entries()) {
    const ms = s.ms;
    switch (s.do) {
      case 'move': await ax('move', X(s.x), Y(s.y), ms ?? 700); break;
      case 'click': case 'double_click': case 'right_click':
        await ax('click', X(s.x), Y(s.y), ms ?? 700, s.do === 'right_click' ? 'right' : 'left', s.do === 'double_click' ? 2 : 1);
        timeline.push({ at: Date.now() - (s.do === 'double_click' ? 330 : 170), do: s.do, x: s.x, y: s.y, label: s.label });
        break;
      case 'drag': await ax('drag', X(s.x), Y(s.y), X(s.to[0]), Y(s.to[1]), ms ?? 800); timeline.push({ at: Date.now(), do: 'drag', x: s.to[0], y: s.to[1], label: s.label }); break;
      case 'scroll': await ax('scroll', s.dy ?? 0, s.dx ?? 0); break;
      case 'type': timeline.push({ at: Date.now(), do: 'type', label: s.label }); await ax('type', s.text, ms ?? 45); break;
      case 'key': { const { code, mods } = parseCombo(s.key); await ax('key', code, ...(mods ? [mods] : [])); break; }
      case 'wait': await sleep(ms ?? 500); break;
      case 'activate': await ax('activate', s.bundleId); break;
      default: throw new Error(`Step ${i + 1}: unknown action "${s.do}". Use move, click, double_click, right_click, drag, scroll, type, key, wait, activate.`);
    }
    if (s.pause) await sleep(s.pause);
  }
  return timeline;
}
