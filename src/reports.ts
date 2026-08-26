import path from 'node:path';
import { getClient } from './client.js';
import { uuid } from './helpers.js';

// Publishing an HTML write-up of finished work.
//
// A dispatched session answers in its transcript as usual — that is what Remote Control shows and it
// is untouched by any of this. A report is a SECOND, richer output: a self-contained page you read on
// the phone, where the model gets to use structure, tables, diagrams and links instead of a wall of
// terminal text.
//
// The hub renders it under a CSP that forbids scripts entirely, so visuals have to be INLINE SVG.
// That is a real constraint on what the model writes, not a detail of the transport, which is why the
// tool description spells it out rather than leaving it to be discovered by having a chart silently
// not appear.

/** Where this is running, if the launcher told us. Set by pi-desk/launch.sh and the Mac orchestrator. */
function sessionId(): string | null {
  return process.env.HUB_SESSION_ID || null;
}

/** The project this session is working in — the cwd's name, which is how every repo here is named. */
function repoName(): string | null {
  const cwd = process.cwd();
  if (cwd === process.env.HOME) return 'root';
  const base = path.basename(cwd);
  return base || null;
}

/**
 * Undo HTML-escaping when a publisher sent entities instead of markup.
 *
 * A model that hedges — writing `&lt;p&gt;` rather than `<p>` — would otherwise publish a page that
 * renders as its own source, which is exactly what happened on the first real report. Decoding is
 * therefore not a nicety, it is what makes the feature survive a model being cautious.
 *
 * The condition is deliberately narrow: decode ONLY when there is no real tag anywhere but there are
 * escaped ones. A genuine fragment always contains at least one real tag, and a report that
 * legitimately shows literal markup inside <code> must keep its entities intact.
 */
function decodeIfFullyEscaped(html: string): string {
  if (/<[a-zA-Z][^>]*>/.test(html)) return html;   // real markup present — trust it as written
  if (!/&lt;[a-zA-Z/]/.test(html)) return html;    // nothing escaped either — plain text, leave it
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');                       // last: &amp;lt; must become &lt;, not <
}

export async function publishReport(title: string, summary: string, html: string): Promise<string> {
  const id = uuid();
  const { error } = await getClient().from('reports').insert({
    id,
    session: sessionId(),
    repo: repoName(),
    title: title.slice(0, 200),
    summary: summary.slice(0, 300),
    html: decodeIfFullyEscaped(html),
  });
  if (error) throw new Error(`could not publish report: ${error.message}`);
  return id;
}
