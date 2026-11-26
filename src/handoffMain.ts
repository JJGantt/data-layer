/** The Mac's handoff agent process (handoffAgent.ts) and screen agent (screenAgent.ts), run by launchd under hands-launch. */
import { createRequire } from 'node:module';
import * as handoffAgent from './handoffAgent.js';
import * as screenAgent from './screenAgent.js';

const ops = createRequire(import.meta.url)('../ops_report.cjs');
ops.install({ machine: process.env.OPS_MACHINE || 'mac', service: 'handoff-agent' });
setInterval(() => ops.beat(60), 60e3);
ops.beat(60);

handoffAgent.start((process.env.HANDOFF_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean));
// Live screen shares need the same grants; a share's helper ends itself when this process's pipe closes.
if (process.env.SCREEN_AGENT !== '0') screenAgent.start();
