// Identity layer: OAuth sign-in, login sessions, and lazily-issued anonymous
// sessions.
//
// Two cookies, deliberately separate:
//   retro_session  signed-in account
//   retro_anon     anonymous visitor (issued on the first WRITE, never on a read,
//                  so a passer-by on a public board costs no database row)
//
// `me.identity` is the value every ownership decision keys off: the user id when
// signed in, otherwise the anonymous session id. Identity is ALWAYS derived
// server-side — nothing a client sends can influence it.

import { cookieHeader, getCookie, hmacHex, HttpError, rid, sha256b64url, str } from "./util.js";

export const SESSION_COOKIE = "retro_session";
export const ANON_COOKIE = "retro_anon";
export const OAUTH_TX_COOKIE = "retro_oauth_tx";

export const SESSION_TTL = 30 * 86400;           // seconds
const OAUTH_TX_TTL = 600;                        // seconds
const WS_TICKET_TTL = 60_000;                    // ms

// Fail-closed: this secret signs OAuth state and websocket tickets. When it is
// missing we refuse those two flows rather than falling back to "allow" — the
// old passcode code returned true here, which turned a missing secret into an
// open site.
function secret(env) {
  const s = (env.SESSION_SECRET || "").trim();
  if (!s) {
    console.error("SESSION_SECRET is not configured — OAuth and websocket tickets are disabled");
    throw new HttpError(503, "not_configured");
  }
  return s;
}

export function oauthConfigured(env, provider) {
  return !!(env.SESSION_SECRET || "").trim() && providerConfig(env, provider).ready();
}

// ----------------------------------------------------------------- providers

const PROVIDERS = {
  google: {
    label: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    pkce: true,
    ready: (env) => !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
    async profile(accessToken) {
      const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new HttpError(502, "profile_fetch_failed");
      const p = await res.json();
      return { providerUserId: p.sub, email: p.email || null, name: p.name || null, avatar: p.picture || null };
    },
  },
  github: {
    label: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    pkce: false, // OAuth Apps do not support PKCE
    ready: (env) => !!env.GITHUB_CLIENT_ID && !!env.GITHUB_CLIENT_SECRET,
    async profile(accessToken) {
      const headers = { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": "free-retro" };
      const res = await fetch("https://api.github.com/user", { headers });
      if (!res.ok) throw new HttpError(502, "profile_fetch_failed");
      const p = await res.json();
      let email = p.email || null;
      if (!email) {
        // the public profile email is usually hidden; read:user user:email is what
        // makes this fallback possible
        const er = await fetch("https://api.github.com/user/emails", { headers });
        if (er.ok) {
          const list = await er.json();
          email = (list.find((e) => e.primary && e.verified) || list.find((e) => e.verified) || [])?.email || null;
        }
      }
      return { providerUserId: String(p.id), email, name: p.name || p.login || null, avatar: p.avatar_url || null };
    },
  },
};

function providerConfig(env, provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new HttpError(400, "unknown_provider");
  return cfg;
}

export function enabledProviders(env) {
  return Object.entries(PROVIDERS)
    .filter(([, cfg]) => cfg.ready(env) && (env.SESSION_SECRET || "").trim())
    .map(([key, cfg]) => ({ id: key, label: cfg.label }));
}

const redirectUri = (url, provider) => `${url.origin}/api/auth/callback/${provider}`;

// ------------------------------------------------------------------ OAuth flow

// state + PKCE verifier, signed into a short-lived cookie so the callback can
// trust them without server state
export async function beginOAuth(env, url, provider, returnTo) {
  const cfg = providerConfig(env, provider);
  if (!cfg.ready(env)) throw new HttpError(503, "provider_not_configured");
  const s = secret(env);

  const nonce = rid(24);
  const verifier = cfg.pkce ? rid(48) : "";
  const exp = String(Date.now() + OAUTH_TX_TTL * 1000);
  const payload = [provider, nonce, verifier, exp, (returnTo || "/").slice(0, 200)].join(".");
  const tx = `${payload}.${await hmacHex(s, payload)}`;

  const params = new URLSearchParams({
    client_id: provider === "google" ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri(url, provider),
    response_type: "code",
    scope: cfg.scope,
    state: nonce,
  });
  if (cfg.pkce) {
    params.set("code_challenge", await sha256b64url(verifier));
    params.set("code_challenge_method", "S256");
  }
  return {
    location: `${cfg.authorizeUrl}?${params}`,
    txCookie: cookieHeader(url, OAUTH_TX_COOKIE, tx, OAUTH_TX_TTL),
  };
}

async function readTx(env, request, provider) {
  const raw = getCookie(request, OAUTH_TX_COOKIE);
  if (!raw) throw new HttpError(400, "oauth_state_missing");
  const cut = raw.lastIndexOf(".");
  if (cut <= 0) throw new HttpError(400, "oauth_state_invalid");
  const payload = raw.slice(0, cut);
  const sig = raw.slice(cut + 1);
  if (sig !== (await hmacHex(secret(env), payload))) throw new HttpError(400, "oauth_state_invalid");
  const [txProvider, nonce, verifier, exp, returnTo] = payload.split(".");
  if (txProvider !== provider) throw new HttpError(400, "oauth_state_invalid");
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) throw new HttpError(400, "oauth_state_expired");
  return { nonce, verifier, returnTo: returnTo || "/" };
}

export async function finishOAuth(env, request, url, provider) {
  const cfg = providerConfig(env, provider);
  const tx = await readTx(env, request, provider);

  const state = url.searchParams.get("state") || "";
  if (state !== tx.nonce) throw new HttpError(400, "oauth_state_mismatch");

  const code = url.searchParams.get("code");
  if (!code) throw new HttpError(400, "oauth_code_missing");

  const body = new URLSearchParams({
    client_id: provider === "google" ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID,
    client_secret: provider === "google" ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri(url, provider),
    grant_type: "authorization_code",
  });
  if (cfg.pkce) body.set("code_verifier", tx.verifier);

  const tokenRes = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.access_token) throw new HttpError(401, "oauth_exchange_failed");

  const profile = await cfg.profile(tokens.access_token);
  if (!profile.providerUserId) throw new HttpError(502, "profile_incomplete");

  const user = await upsertUser(env, provider, profile);
  return { user, returnTo: tx.returnTo };
}

// One account per (provider, provider_user_id). Email is only stored, never used
// to merge: GitHub frequently exposes no usable address, and matching on it would
// let a provider's unverified email claim someone else's account.
async function upsertUser(env, provider, profile) {
  const existing = await env.DB.prepare(
    "SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_user_id = ?"
  )
    .bind(provider, profile.providerUserId)
    .first();
  if (existing) {
    await env.DB.prepare("UPDATE users SET email = COALESCE(?, email), avatar_url = COALESCE(?, avatar_url) WHERE id = ?")
      .bind(profile.email, profile.avatar, existing.user_id)
      .run();
    return await getUser(env, existing.user_id);
  }

  const user = { id: rid(14), email: profile.email, name: profile.name, avatar: profile.avatar, created_at: Date.now() };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(user.id, user.email, user.name, user.avatar, user.created_at),
    env.DB.prepare("INSERT INTO oauth_identities (provider, provider_user_id, user_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(provider, profile.providerUserId, user.id, user.created_at),
  ]);
  return user;
}

async function getUser(env, id) {
  const row = await env.DB.prepare("SELECT id, email, name, avatar_url FROM users WHERE id = ?").bind(id).first();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, avatar: row.avatar_url };
}

// ----------------------------------------------------------------- sessions

export async function createLoginSession(env, userId) {
  const id = rid(32);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, userId, now + SESSION_TTL * 1000, now)
    .run();
  return id;
}

async function createAnonSession(env) {
  const id = rid(32);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, NULL, ?, ?)")
    .bind(id, now + SESSION_TTL * 1000, now)
    .run();
  return id;
}

async function sessionById(env, id) {
  if (!id || !/^[a-z0-9]+$/.test(id)) return null;
  const row = await env.DB.prepare("SELECT id, user_id, expires_at FROM sessions WHERE id = ?").bind(id).first();
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

async function resolveMe(request, env) {
  const loginId = getCookie(request, SESSION_COOKIE);
  const login = await sessionById(env, loginId);
  if (login?.user_id) {
    return { kind: "user", userId: login.user_id, identity: login.user_id, sessionId: login.id };
  }

  const anonId = getCookie(request, ANON_COOKIE);
  const anon = await sessionById(env, anonId);
  if (anon) {
    return { kind: "anon", userId: null, identity: anon.id, sessionId: anon.id };
  }

  return { kind: "none", userId: null, identity: null, sessionId: null };
}

// The moving parts a request needs, plus the cookies it wants to set. Cookies are
// collected here and attached to whatever Response the router returns.
export function createAuth(request, env) {
  const url = new URL(request.url);
  const cookies = [];
  let resolved = null;

  async function me() {
    if (!resolved) resolved = await resolveMe(request, env);
    return resolved;
  }

  return {
    cookies,
    url,
    me,

    // For writes that must be attributable to someone. Mints an anonymous session
    // on first use. Call this AFTER the permission check and AFTER validating the
    // payload — minting on a rejected request would let a bot create a row per
    // denied call.
    async ensureIdentity() {
      const current = await me();
      if (current.identity) return current;
      const id = await createAnonSession(env);
      cookies.push(cookieHeader(url, ANON_COOKIE, id, SESSION_TTL));
      resolved = { kind: "anon", userId: null, identity: id, sessionId: id };
      return resolved;
    },

    async signIn(userId) {
      const previous = await me();
      const sessionId = await createLoginSession(env, userId);
      cookies.push(cookieHeader(url, SESSION_COOKIE, sessionId, SESSION_TTL));

      // Anything the visitor wrote before signing in was keyed to the anonymous
      // session id. Without this handover those notes become uneditable by their
      // own author and the votes can be cast a second time.
      if (previous.kind === "anon" && previous.sessionId) {
        await claimOwnership(env, previous.sessionId, userId);
        cookies.push(cookieHeader(url, ANON_COOKIE, "", 0));
      }
      resolved = { kind: "user", userId, identity: userId, sessionId };
      return sessionId;
    },

    async signOut() {
      const current = await me();
      if (current.kind === "user" && current.sessionId) {
        await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(current.sessionId).run();
      }
      cookies.push(cookieHeader(url, SESSION_COOKIE, "", 0));
      // the anonymous cookie is left alone: signing out returns you to being a
      // visitor, not to holding the identity that was just migrated away
      resolved = { kind: "none", userId: null, identity: null, sessionId: null };
    },

    // The user id this request is signed in as, or null. Use for endpoints that
    // are legitimately unavailable to visitors.
    async requireUser() {
      const current = await me();
      if (!current.userId) throw new HttpError(401, "unauthorized");
      return current;
    },
  };
}

// Move notes and votes from a (now-retired) identity to a user id.
export async function claimOwnership(env, fromIdentity, userId) {
  if (!fromIdentity || !userId || fromIdentity === userId) return;
  await env.DB.batch([
    env.DB.prepare("UPDATE notes SET owner_id = ? WHERE owner_id = ?").bind(userId, fromIdentity),
    env.DB.prepare("UPDATE votes SET voter    = ? WHERE voter    = ?").bind(userId, fromIdentity),
  ]);
}

// ------------------------------------------------------------ websocket ticket

// A browser authenticates the websocket with its session cookie. Non-browser
// clients (the test suite) cannot set headers on a WebSocket handshake, so they
// mint a ticket instead. Tickets are short-lived and bound to one board, which is
// what keeps them from being the long-lived credential in a URL that the old
// passcode token was.
export async function mintWsTicket(env, sessionId, boardId) {
  const exp = String(Date.now() + WS_TICKET_TTL);
  const sig = await hmacHex(secret(env), `ws:${boardId}:${exp}:${sessionId}`);
  return `${exp}.${sessionId}.${sig}`;
}

export async function verifyWsTicket(env, ticket, boardId) {
  const parts = (ticket || "").split(".");
  if (parts.length !== 3) return null;
  const [exp, sessionId, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  if (sig !== (await hmacHex(secret(env), `ws:${boardId}:${exp}:${sessionId}`))) return null;
  return sessionId;
}

// Resolve an identity from a websocket ticket, so /ws can serve clients that
// cannot send a cookie.
export async function meFromTicket(env, ticket, boardId) {
  const sessionId = await verifyWsTicket(env, ticket, boardId);
  if (!sessionId) return null;
  const row = await sessionById(env, sessionId);
  if (!row) return null;
  return row.user_id
    ? { kind: "user", userId: row.user_id, identity: row.user_id, sessionId: row.id }
    : { kind: "anon", userId: null, identity: row.id, sessionId: row.id };
}

// ----------------------------------------------------------------- cleanup

// Expiry has two jobs, and the order matters: an expired anonymous session still
// owns notes, so hand those notes to the board owner BEFORE deleting the session
// row, or the ownership is lost with it (docs/permission-matrix.md rule 20).
export async function purgeExpiredSessions(env) {
  const now = Date.now();

  const { results: expiring } = await env.DB.prepare(
    "SELECT id FROM sessions WHERE user_id IS NULL AND expires_at < ? LIMIT 200"
  )
    .bind(now)
    .all();

  if (expiring.length) {
    const ids = expiring.map((s) => s.id);
    const ph = ids.map(() => "?").join(",");

    // notes → the board's owner (created_by). Boards with a NULL created_by (legacy)
    // and owners who have left the team keep the note but leave nobody but a TADMIN
    // able to touch it.
    await env.DB.prepare(
      `UPDATE notes SET owner_id = (SELECT created_by FROM boards WHERE boards.id = notes.board_id)
       WHERE owner_id IN (${ph})`
    )
      .bind(...ids)
      .run();

    // votes are dropped rather than reassigned: handing them to the board owner
    // would invent votes that nobody cast, and leaving them would leave a
    // permanent tally that can never be withdrawn while the same visitor can vote
    // again with a fresh session.
    await env.DB.prepare(`DELETE FROM votes WHERE voter IN (${ph})`).bind(...ids).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE id IN (${ph})`).bind(...ids).run();
  }

  // signed-in sessions are simply dropped — their notes are keyed to the user id,
  // which outlives the session
  await env.DB.prepare("DELETE FROM sessions WHERE user_id IS NOT NULL AND expires_at < ?").bind(now).run();

  return expiring.length;
}

// ------------------------------------------------------------------- dev login

// Lets local development and the test suite sign in without registering OAuth
// apps. Off unless ALLOW_DEV_LOGIN is explicitly "1" (set in .dev.vars for local
// runs; CI writes its own .dev.vars).
export function devLoginEnabled(env) {
  return (env.ALLOW_DEV_LOGIN || "").trim() === "1";
}

export async function devSignIn(env, body) {
  const email = str(body.email, 200) || `dev-${rid(6)}@localhost`;
  const existing = await env.DB.prepare("SELECT user_id FROM oauth_identities WHERE provider = 'dev' AND provider_user_id = ?")
    .bind(email)
    .first();
  if (existing) return await getUser(env, existing.user_id);

  const user = { id: rid(14), email, name: str(body.name, 60) || email.split("@")[0], avatar: null, created_at: Date.now() };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, NULL, ?)")
      .bind(user.id, user.email, user.name, user.created_at),
    env.DB.prepare("INSERT INTO oauth_identities (provider, provider_user_id, user_id, created_at) VALUES ('dev', ?, ?, ?)")
      .bind(email, user.id, user.created_at),
  ]);
  return user;
}
