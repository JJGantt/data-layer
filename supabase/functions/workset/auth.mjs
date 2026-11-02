// Whether a request carries a device token this function accepts.
//
// Each device holds a random token (Workset's gitignored Config/Secrets.xcconfig); the function holds
// only SHA-256 hex digests of the accepted tokens, comma-separated, in its WORKSET_DEVICE_SHA256
// secret. Plain JS rather than TS so the node test suite (test/workset-auth.test.mjs) runs this exact
// file; WebCrypto is the same API in Deno and Node.

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** token: the X-Device-Token header value. accepted: the WORKSET_DEVICE_SHA256 secret. */
export async function deviceAuthorised(token, accepted) {
  if (!token || !accepted) return false;
  const want = accepted.split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h));
  if (!want.length) return false;
  const got = await sha256Hex(token);
  return want.some((h) => sameHex(got, h));
}
