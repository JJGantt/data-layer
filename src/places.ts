import { createSign } from 'node:crypto';
import { getClient } from './client.js';

// Human names for positions, from the Apple Maps Server API: the street address at a spot and, when Apple
// knows one there, the business or landmark. Used by `get_location` so an answer says "at Publix on Beach
// Blvd", not a pair of coordinates.
//
// Apple has no "what is at this point" call for businesses. Reverse geocoding gives the ADDRESS; the business
// comes from a search for that address near the point, keeping the nearest POI within POI_M. A miss is
// cached too (poi null), so each spot costs at most two calls, once, for every machine (`place_names`, 00183).
//
// Credentials: MAPS_KEY_ID and MAPS_PRIVATE_KEY (the .p8's PEM, newlines as \n) in each machine's
// environment — data-layer/.env on the Mac and the Pi, Fly secrets on jared-voice-worker — with MAPS_TEAM_ID.
// A Maps key is a MapKit JS key tied to a Maps ID (README § Place names). Without them, no names: callers
// fall back to coordinates and the failure is logged as an error.

const API = 'https://maps-api.apple.com/v1';
const POI_M = 60;             // a business further than this from the point is not "where he was"
const PARALLEL = 4;

export interface Place { address: string | null; poi: string | null; area: string | null }

const keyOf = (lat: number, lon: number) => `${lat.toFixed(4)},${lon.toFixed(4)}`;

function metres(a: { latitude: number; longitude: number }, lat: number, lon: number): number {
  const r = Math.PI / 180, dLat = (lat - a.latitude) * r, dLon = (lon - a.longitude) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

let token: { value: string; until: number } | null = null;
let warned = false;

function configured(): boolean {
  const ok = !!(process.env.MAPS_KEY_ID && process.env.MAPS_PRIVATE_KEY && process.env.MAPS_TEAM_ID);
  if (!ok && !warned) { warned = true; console.error('[places] MAPS_KEY_ID / MAPS_PRIVATE_KEY / MAPS_TEAM_ID not set: no place names'); }
  return ok;
}

async function accessToken(): Promise<string> {
  if (token && token.until > Date.now() + 60e3) return token.value;
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b({ alg: 'ES256', kid: process.env.MAPS_KEY_ID, typ: 'JWT' });
  const body = b({ iss: process.env.MAPS_TEAM_ID, iat: now, exp: now + 3600, scope: 'server_api' });
  const pem = process.env.MAPS_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key: pem, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const r = await fetch(`${API}/token`, { headers: { Authorization: `Bearer ${head}.${body}.${sig}` } });
  if (!r.ok) throw new Error(`Apple Maps token: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  token = { value: j.accessToken, until: Date.now() + (j.expiresInSeconds ?? 1800) * 1000 };
  return token.value;
}

async function call(path: string, params: Record<string, string>): Promise<any> {
  const r = await fetch(`${API}${path}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  if (!r.ok) throw new Error(`Apple Maps ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** Ask Apple what is at one point. */
export async function lookUp(lat: number, lon: number): Promise<Place> {
  const loc = `${lat},${lon}`;
  const rev = await call('/reverseGeocode', { loc, lang: 'en-US' });
  const a = rev.results?.[0];
  if (!a) return { address: null, poi: null, area: null };
  const s = a.structuredAddress ?? {};
  const street = s.fullThoroughfare ?? a.name ?? null;
  const address = [street, s.locality, s.administrativeAreaCode].filter(Boolean).join(', ') || null;
  const area = s.areasOfInterest?.[0] ?? s.subLocality ?? null;
  let poi: string | null = null;
  if (street) {
    const found = await call('/search', { q: [street, s.locality].filter(Boolean).join(', '), searchLocation: loc,
      resultTypeFilter: 'Poi', lang: 'en-US' });
    const near = (found.results ?? [])
      .filter((p: any) => p.coordinate && metres(p.coordinate, lat, lon) <= POI_M)
      .sort((x: any, y: any) => metres(x.coordinate, lat, lon) - metres(y.coordinate, lat, lon));
    poi = near[0]?.name ?? null;
  }
  return { address, poi, area };
}

/** Names for many points, from the shared cache where it has them and Apple where it does not.
 *  Returns null when the Maps key is not configured or Apple cannot be reached. */
export async function placesFor(points: { lat: number; lon: number }[]): Promise<Map<string, Place> | null> {
  if (!points.length || !configured()) return null;
  const keys = [...new Set(points.map((p) => keyOf(p.lat, p.lon)))];
  const out = new Map<string, Place>();
  const db = getClient();
  const { data, error } = await db.from('place_names').select('key,address,poi,area').in('key', keys);
  if (error) console.error(`[places] cache read: ${error.message}`);
  for (const r of data ?? []) out.set(r.key, { address: r.address, poi: r.poi, area: r.area });
  const missing = keys.filter((k) => !out.has(k));
  try {
    for (let i = 0; i < missing.length; i += PARALLEL) {
      const batch = missing.slice(i, i + PARALLEL);
      const got = await Promise.all(batch.map((k) => { const [la, lo] = k.split(',').map(Number); return lookUp(la, lo); }));
      batch.forEach((k, j) => out.set(k, got[j]));
      const rows = batch.map((k, j) => ({ key: k, ...got[j] }));
      const w = await db.from('place_names').upsert(rows);
      if (w.error) console.error(`[places] cache write: ${w.error.message}`);
    }
  } catch (e) {
    console.error(`[places] ${(e as Error).message}`);
    if (!out.size) return null;
  }
  return out;
}

export function placeKey(lat: number, lon: number): string { return keyOf(lat, lon); }

/** One place as words: the business if there is one, then the address. */
export function placeText(p: Place | undefined): string | null {
  if (!p || (!p.poi && !p.address)) return null;
  return [p.poi, p.address].filter(Boolean).join(', ');
}
