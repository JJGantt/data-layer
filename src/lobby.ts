// The building's downstairs door (ButterflyMX), opened by racing every path to his phone (status-hub
// docs/DOOR.md § Lobby door; tables lobby_races / lobby_events, migration 00219).
//
// `startRace` is the caller's side, from any machine (the front_door tool's `lobby` op): it inserts a
// race, and the hub sends the SMS and the email the moment it sees it. `start` is the Mac's side (the
// home agent): it claims each race and sends the iMessage, which only the Mac can send (Messages.app,
// through the messages MCP over HTTP on this machine, authenticated with MESSAGES_MCP_TOKEN in the home
// agent's environment). There is no fallback for this path: no other
// machine has iMessage, and the race's other paths are what cover the Mac being asleep.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getClient } from './client.js';
import { onInserts } from './realtime.js';

const CODEWORD = 'open-lobby-7731';

export async function startRace(reason: string, door: 'main' | 'north' | 'south' = 'main'): Promise<string> {
  const { data, error } = await getClient().from('lobby_races').insert({ reason, door }).select('id, created_at').single();
  if (error) throw new Error(`Starting the lobby door race failed: ${error.message}`);
  return `Lobby door: sent (race ${data.id}). It opens when the phone's shortcut runs; the race shows on the hub's elevator page.`;
}

async function setting(key: string): Promise<string> {
  const { data, error } = await getClient().from('app_settings').select('value').eq('key', key).maybeSingle();
  if (error) throw new Error(error.message);
  return String((data as any)?.value ?? '').trim();
}

async function sendImessage(to: string, token: string, text: string): Promise<void> {
  const url = process.env.MESSAGES_MCP_URL || 'http://127.0.0.1:27187/mcp';
  const client = new Client({ name: 'lobby', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const r: any = await client.callTool({ name: 'send_message', arguments: { text, to } });
    if (r.isError) throw new Error(`send_message: ${JSON.stringify(r.content).slice(0, 300)}`);
  } finally {
    await client.close().catch(() => {});
  }
}

async function event(race_id: string, row: Record<string, unknown>): Promise<void> {
  const { error } = await getClient().from('lobby_events').insert({ race_id, kind: 'send', path: 'imessage', ...row });
  if (error) console.error(`[lobby] recording the iMessage send for ${race_id} failed: ${error.message}`);
}

async function answer(race: any): Promise<void> {
  try {
    const to = await setting('lobby_imessage_to');
    if (!to) {
      console.log(`[lobby] ${race.id} imessage skipped: app_settings.lobby_imessage_to not set`);
      return event(race.id, { ok: false, skipped: true, error: 'app_settings.lobby_imessage_to not set' });
    }
    const token = process.env.MESSAGES_MCP_TOKEN || '';
    if (!token) {
      console.error(`[lobby] ${race.id} imessage not sent: MESSAGES_MCP_TOKEN is not set for the home agent`);
      return event(race.id, { ok: false, skipped: true, error: 'MESSAGES_MCP_TOKEN not set for the home agent' });
    }
    await sendImessage(to, token, `${CODEWORD} ${race.door || 'main'} ${race.nonce} imessage`);
    await event(race.id, { ok: true });
  } catch (e: any) {
    console.error(`[lobby] ${race.id} iMessage send failed: ${e.message || e}`);
    await event(race.id, { ok: false, error: String(e.message || e).slice(0, 300) });
  }
}

/** The Mac's iMessage sender (home agent). No defer: the Mac is the only machine that can do it. */
export const start = () => onInserts('lobby_races', answer, 0);
