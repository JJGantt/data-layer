#!/usr/bin/env node
// One-time OAuth for the YouTube Data API: the owner approves once in a browser, and the refresh token
// written to .env is what every later call uses (src/youtubeApi.ts).
//
// The OAuth client is the gmail-mcp one (Google Cloud project status-hub-507320, published to production,
// so its refresh tokens do not expire after 7 days). Its id and secret are read from ~/repos/gmail-mcp/.env
// and written beside the token as YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET.
//
// Prints the consent URL rather than opening a browser: run from an agent session, the browser and the
// terminal are not the same context. A loopback server on this machine catches the redirect.
//
//   node bin/youtube-authorize.mjs
//
// Scope `youtube`: read the account and like, subscribe and add to playlists. Watch history and home
// recommendations are not in the Data API at all; those stay with the browser (youtubeAccount.ts).
import http from 'node:http';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCOPE = 'https://www.googleapis.com/auth/youtube';
const ENV = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

const readEnv = (p) => Object.fromEntries(readFileSync(p, 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const g = readEnv(join(homedir(), 'repos', 'gmail-mcp', '.env'));
const clientId = g.GOOGLE_CLIENT_ID, clientSecret = g.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) { console.error('no GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in gmail-mcp/.env'); process.exit(1); }

const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
  }).toString();
  console.log(`\nApprove here:\n\n${url}\n`);

  server.on('request', async (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    if (!q.get('code')) { res.end(q.get('error') || 'waiting'); if (q.get('error')) { console.error(q.get('error')); process.exit(1); } return; }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ code: q.get('code'), client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    const tok = await r.json();
    if (!tok.refresh_token) { res.end('failed'); console.error('no refresh token returned:', JSON.stringify(tok)); process.exit(1); }
    let text = '';
    try { text = readFileSync(ENV, 'utf8'); } catch {}
    const keep = text.split('\n').filter((l) => l && !/^YOUTUBE_(CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN)=/.test(l));
    keep.push(`YOUTUBE_CLIENT_ID=${clientId}`, `YOUTUBE_CLIENT_SECRET=${clientSecret}`, `YOUTUBE_REFRESH_TOKEN=${tok.refresh_token}`);
    writeFileSync(ENV, keep.join('\n') + '\n');
    chmodSync(ENV, 0o600);
    res.end('Done. You can close this tab.');
    console.log(`wrote YOUTUBE_* to ${ENV}`);
    server.close();
    process.exit(0);
  });
});
