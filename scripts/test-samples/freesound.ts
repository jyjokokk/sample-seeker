// S24: minimal Freesound APIv2 client for build.ts: credentials, OAuth2 and throttled downloads.
//
// Every developer downloads the sounds with their own Freesound API credentials, so the audio is never
// re-hosted (Freesound API terms §4(a)). Credentials:
//   ~/.config/freesound/client_id      (or FREESOUND_CLIENT_ID)
//   ~/.config/freesound/client_secret  (or FREESOUND_CLIENT_SECRET; Freesound calls it the API key)
//   ~/.config/freesound/token.json     written by `pnpm test-samples auth <code>`, refreshed automatically
// Original files need OAuth2; https://freesound.org/docs/api/authentication.html

import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const API = "https://freesound.org/apiv2";
const CONFIG = process.env.FREESOUND_CONFIG_DIR ?? join(homedir(), ".config/freesound");
const TOKEN_FILE = join(CONFIG, "token.json");

// Freesound keeps ONE request history per user for all API calls, and the download endpoint checks it
// against stricter limits: 30 requests a minute and 500 a day (MTG/freesound: DownloadAPIView,
// APIV2_POST_THROTTLING_RATES_PER_LEVELS). So every request, not only downloads, counts towards those.
// Spacing all requests 2.1 s apart stays under 30 a minute; fetching metadata in one search request keeps
// the daily count to about one request per sound.
const REQUEST_GAP_MS = 2100;
// Wait and retry when Freesound asks for at most this long; a longer wait means the daily limit.
const MAX_RETRY_WAIT_S = 120;

export const CC0 = /^https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/;

export class AuthError extends Error {}

export interface SoundInfo {
  id: number;
  name: string;
  username: string;
  license: string;
  type: string;
  filesize: number;
  url: string;
}

interface Token {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number | string;
}

function readSecret(envName: string, file: string): string | null {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv.trim();
  const path = join(CONFIG, file);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}

function credentials() {
  const clientId = readSecret("FREESOUND_CLIENT_ID", "client_id");
  const clientSecret = readSecret("FREESOUND_CLIENT_SECRET", "client_secret");
  if (!clientId || !clientSecret)
    throw new AuthError(
      `Freesound API credentials missing: put your client id and client secret in ${CONFIG}/client_id ` +
        `and ${CONFIG}/client_secret (chmod 600). Get them at https://freesound.org/apiv2/apply`,
    );
  return { clientId, clientSecret };
}

// Freesound requires PKCE (S256): the authorize link carries a hash of a one-time secret (the verifier),
// and the code exchange must send the secret itself. The verifier is kept in a private file in between.
const VERIFIER_FILE = join(CONFIG, "pkce_verifier");

export function authorizeUrl(): string {
  const { clientId } = credentials();
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  mkdirSync(CONFIG, { recursive: true, mode: 0o700 });
  writeFileSync(VERIFIER_FILE, verifier, { mode: 0o600 });
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${API}/oauth2/authorize/?${params}`;
}

function saveToken(body: TokenResponse): Token {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  const token: Token = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    // Refresh a minute early.
    expires_at: Date.now() + (Number(body.expires_in) - 60) * 1000,
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), { mode: 0o600 });
  return token;
}

async function tokenRequest(params: Record<string, string>): Promise<Token> {
  const { clientId, clientSecret } = credentials();
  const res = await fetch(`${API}/oauth2/access_token/`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  if (!res.ok) throw new AuthError(`Freesound token request failed: HTTP ${res.status}`);
  return saveToken((await res.json()) as TokenResponse);
}

/** Exchanges the code shown after authorizing (valid ~10 minutes) for a token, and saves it. */
export async function exchangeCode(code: string): Promise<Token> {
  if (!existsSync(VERIFIER_FILE))
    throw new AuthError(
      "no pending login: run `pnpm test-samples auth` first and use the link it prints",
    );
  const verifier = readFileSync(VERIFIER_FILE, "utf8").trim();
  const token = await tokenRequest({
    grant_type: "authorization_code",
    code: code.trim(),
    code_verifier: verifier,
  });
  rmSync(VERIFIER_FILE, { force: true });
  return token;
}

async function accessToken(): Promise<string> {
  const hint = "run `pnpm test-samples auth` to log in to Freesound";
  if (!existsSync(TOKEN_FILE)) throw new AuthError(`not logged in to Freesound: ${hint}`);
  let token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Token;
  if (Date.now() >= token.expires_at) {
    try {
      token = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
      });
    } catch {
      throw new AuthError(`Freesound login expired: ${hint}`);
    }
  }
  return token.access_token;
}

// ---------- throttled requests ----------

/** Freesound refused a request because of its rate limits and wants us to wait longer than is sensible. */
export class RateLimitError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequest = 0;

async function throttled(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401)
      throw new AuthError("Freesound rejected the login: run `pnpm test-samples auth`");
    if (res.status !== 429) return res;

    // Freesound (Django REST framework) says why in the body, e.g. "... limit rate (500/day)", and how long
    // to wait in Retry-After. For the daily limit Retry-After is still ~60 s, which is useless: the limit
    // is a rolling 24 h window, so requests free up 24 h after they were made. Stop at once instead.
    const retryAfter = Number(res.headers.get("retry-after") ?? 60);
    const detail = await res
      .json()
      .then((b) => (b as { detail?: string }).detail ?? "")
      .catch(() => "");
    if (/\/day\b/.test(detail))
      throw new RateLimitError(
        `Freesound's daily limit reached (${detail}). It counts all of your Freesound account's API ` +
          "requests over a rolling 24 hours, so capacity frees up 24 h after the requests were made. " +
          "Progress is saved: run `pnpm test-samples` again later to download the rest.",
      );
    if (retryAfter > MAX_RETRY_WAIT_S || attempt === 3)
      throw new RateLimitError(
        `Freesound rate limit: ${detail || "too many requests"}. Progress is saved: ` +
          "run `pnpm test-samples` again in a few minutes.",
      );
    console.warn(`  Freesound rate limit (${detail || "429"}), waiting ${retryAfter} s…`);
    await sleep(retryAfter * 1000);
  }
}

/**
 * Metadata of many sounds with as few requests as possible (one per 100 ids), so that the daily request
 * limit goes to downloads. Sounds missing from the result no longer exist on Freesound.
 */
export async function soundInfos(ids: number[]): Promise<Map<number, SoundInfo>> {
  const infos = new Map<number, SoundInfo>();
  const fields = "id,name,username,license,type,filesize,url";
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const params = new URLSearchParams({
      filter: `id:(${chunk.join(" OR ")})`,
      fields,
      page_size: "150",
    });
    const res = await throttled(`${API}/search/text/?${params}`);
    if (!res.ok) throw new Error(`Freesound search for sound metadata: HTTP ${res.status}`);
    const body = (await res.json()) as { results: SoundInfo[] };
    for (const info of body.results) infos.set(info.id, info);
  }
  return infos;
}

/** Downloads the original file of a sound to dest (via dest.part, so a failed download leaves nothing). */
export async function downloadOriginal(id: number, dest: string): Promise<void> {
  const res = await throttled(`${API}/sounds/${id}/download/`);
  if (!res.ok || !res.body)
    throw new Error(`Freesound sound ${id}: download failed, HTTP ${res.status}`);
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    renameSync(part, dest);
  } finally {
    rmSync(part, { force: true });
  }
}
