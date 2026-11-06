/**
 * The Mac's home agent: the fallback for the Pi's home-network jobs (README § The home-network jobs).
 *
 * Subscribes to the same inserts data-http answers on the Pi (`tv_commands`, `home_requests`) but waits
 * HOME_DEFER_MS before claiming, so while the Pi is up it always finds each row already taken and does
 * nothing. A row it wins is one the Pi never claimed, which onInserts reports as an error.
 *
 * Run by launchd (launchd/com.jaredgantt.home-agent.plist), which sets YT_BROWSER_PROFILE and
 * YT_BROWSER_CDP for youtubeAccount.ts's on-demand browser.
 */
import { createRequire } from 'node:module';
import * as tvHome from './tvHome.js';
import * as homeRequests from './homeRequests.js';

// ops_report.cjs is a copy of the ops responder's reporter (edit it there). Installed first, so nothing
// fails before it listens; the beat rides the event loop, which is this process's work loop.
const ops = createRequire(import.meta.url)('../ops_report.cjs');
ops.install({ machine: process.env.OPS_MACHINE || 'mac', service: 'home-agent' });
setInterval(() => ops.beat(60), 60e3);
ops.beat(60);

const defer = Number(process.env.HOME_DEFER_MS || 4000);
tvHome.start(defer);
homeRequests.start(defer);
console.log(`[home-agent] fallback for the Pi, claiming after ${defer / 1000}s`);
