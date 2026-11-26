import { getClient } from './client.js';
import { ValidationError } from './helpers.js';
import { selfConversation } from './desk.js';
import { storeImage } from './images.js';

// SESSION TABS — what a session shows beside its conversation in the phone's session view
// (status-hub docs/SESSION-TABS.md). The `session_tab` tool opens, changes and closes CONTENT tabs:
// a picture, a chart, a markdown page or an HTML page. Its `list` also shows the LIVE CHROME tabs the
// session has, which nothing here opens: the Mac's and the Pi's chrome-tabs hook claims one when the
// session's Chrome tools first touch a tab, and it closes with the tab.
//
// A tab belongs to the session's conversation, so it survives a resume. Only the session that opened a
// tab can change it: every op is scoped to the caller's own conversation.

export type Format = 'markdown' | 'html' | 'image';
export type Content = { markdown?: string; html?: string; image_path?: string; image_url?: string };

type Row = { id: string; kind: string; title: string | null; format: string | null; machine: string | null;
  url: string | null; created_at: string; updated_at: string };

const MAX_TEXT = 1_000_000;

async function mine(): Promise<string> {
  const conv = await selfConversation();
  if (!conv) throw new ValidationError('this is not running inside a hub session, so there is no session view to put a tab on');
  return conv;
}

/** The one piece of content a call carries, as the columns that hold it. */
async function contentOf(c: Content): Promise<{ format: Format; body: string | null; image: string | null } | null> {
  const given = [c.markdown != null, c.html != null, !!(c.image_path || c.image_url)].filter(Boolean).length;
  if (!given) return null;
  if (given > 1) throw new ValidationError('give ONE of markdown, html, or an image (image_path / image_url)');
  if (c.markdown != null || c.html != null) {
    const body = String(c.markdown ?? c.html);
    if (body.length > MAX_TEXT) throw new ValidationError(`that is ${body.length} characters; the limit is ${MAX_TEXT}`);
    return { format: c.markdown != null ? 'markdown' : 'html', body, image: null };
  }
  return { format: 'image', body: null, image: await storeImage({ path: c.image_path, url: c.image_url }) };
}

function line(r: Row): string {
  const what = r.kind === 'chrome' ? `live Chrome tab on the ${r.machine === 'pi' ? 'Pi' : 'Mac'}${r.url ? ` (${r.url})` : ''}` : `${r.format}`;
  return `- ${r.id} · ${r.title || '(untitled)'} · ${what}`;
}

export async function open(title: string, c: Content): Promise<string> {
  const conversation = await mine();
  const content = await contentOf(c);
  if (!content) throw new ValidationError('nothing to show: give markdown, html, image_path or image_url');
  const t = String(title || '').trim().slice(0, 40);
  if (!t) throw new ValidationError('give the tab a `title`: one or two words, it is the tab\'s label');
  const { data, error } = await getClient().from('session_tabs')
    .insert({ conversation, kind: 'content', title: t, ...content }).select('id').single();
  if (error) throw new Error(`could not open the tab: ${error.message}`);
  return `Opened tab ${data.id} ("${t}"). It is on your session view on his phone now; change it with update and this id, close it when it is no longer useful.`;
}

export async function update(id: string, title: string | undefined, c: Content): Promise<string> {
  const conversation = await mine();
  const content = await contentOf(c);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), ...(content || {}) };
  if (title != null && String(title).trim()) patch.title = String(title).trim().slice(0, 40);
  if (!content && !patch.title) throw new ValidationError('nothing to change: give a title or new content');
  const { data, error } = await getClient().from('session_tabs').update(patch)
    .eq('id', id).eq('conversation', conversation).eq('kind', 'content').is('closed_at', null).select('id');
  if (error) throw new Error(`could not update the tab: ${error.message}`);
  if (!data?.length) throw new ValidationError(`no open content tab ${id} on this session; list shows the ones it has`);
  return `Updated tab ${id}.`;
}

export async function close(id: string): Promise<string> {
  const conversation = await mine();
  const { data, error } = await getClient().from('session_tabs').update({ closed_at: new Date().toISOString() })
    .eq('id', id).eq('conversation', conversation).eq('kind', 'content').is('closed_at', null).select('id');
  if (error) throw new Error(`could not close the tab: ${error.message}`);
  if (!data?.length) throw new ValidationError(`no open content tab ${id} on this session (a live Chrome tab closes with its browser tab)`);
  return `Closed tab ${id}.`;
}

export async function list(): Promise<string> {
  const conversation = await mine();
  const { data, error } = await getClient().from('session_tabs')
    .select('id,kind,title,format,machine,url,created_at,updated_at')
    .eq('conversation', conversation).is('closed_at', null).order('created_at');
  if (error) throw new Error(`could not read the tabs: ${error.message}`);
  const rows = (data ?? []) as Row[];
  return rows.length ? `Open tabs on this session:\n${rows.map(line).join('\n')}` : 'This session has no tabs open.';
}
