// Print an app's accessibility tree compactly: node test/dump.mjs [bundleId]
import { ax } from '../src/helper.js';
const t = await ax('tree', process.argv[2] || 'pl.maketheweb.cleanshotx');
const walk = (n, d = 0) => {
  if (n.role === 'AXMenuItem' && n.path.startsWith('x')) return;
  console.log('  '.repeat(d) + [n.path, n.role, n.subrole, n.title && `t=${JSON.stringify(n.title)}`, n.desc && `d=${JSON.stringify(n.desc)}`, n.id, n.value !== undefined && JSON.stringify(String(n.value).slice(0, 50)), `[${n.frame}]`].filter(Boolean).join(' '));
  (n.children || []).forEach((c) => walk(c, d + 1));
};
t.roots.forEach((r) => walk(r));
