// Small shared helpers for the Worker: ids, JSON responses, cookie plumbing.

// unambiguous lowercase alphabet — ids are read aloud and typed by hand
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function rid(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let id = "";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export function getCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

export async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256b64url(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64url(digest);
}

export function str(v, max) {
  return (v ?? "").toString().trim().slice(0, max);
}

// Thrown by guards and auth code; the router turns it into a JSON error.
// `status` is the contract the frontend keys off:
//   401 not signed in      403 readable but not allowed      404 not found / not readable
export class HttpError extends Error {
  constructor(status, error, extra) {
    super(error);
    this.status = status;
    this.error = error;
    Object.assign(this, extra || {});
  }
}

export const fail = (status, error, extra) => {
  throw new HttpError(status, error, extra);
};

// build a Set-Cookie value; `secure` is off on localhost so the cookie survives
// plain-http development
export function cookieHeader(url, name, value, maxAge) {
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAge === 0) parts.push("Max-Age=0");
  else if (maxAge) parts.push(`Max-Age=${maxAge}`);
  if (!local) parts.push("Secure");
  return parts.join("; ");
}

export function withCookies(response, cookies) {
  if (!cookies?.length) return response;
  const headers = new Headers(response.headers);
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
