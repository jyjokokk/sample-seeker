// S24: minimal Freesound APIv2 client for build.ts: credentials, OAuth2 (with PKCE) and throttled downloads.
// Setup and the reasons behind it: scripts/test-samples/README.md.

import { createHash, randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://freesound.org/apiv2";
const CONFIG = join(homedir(), ".config/freesound");
const TOKEN_FILE = join(CONFIG, "token.json");

// Freesound keeps ONE request history per user for all API calls, and the download endpoint checks it
// against stricter limits: 30 requests a minute and 500 a day (MTG/freesound: DownloadAPIView,
// APIV2_POST_THROTTLING_RATES_PER_LEVELS). So every request counts towards those; 2.1 s apart stays under 30.
const REQUEST_GAP_MS = 2100;
// Wait and retry when Freesound asks for at most this long.
const MAX_RETRY_WAIT_S = 120;

/** Missing or rejected Freesound login: running `pnpm test-samples auth` fixes it. */
export class AuthError extends Error {}

export interface SoundInfo {
  id: number;
  name: string;
  username: string;
  license: string;
  type: string;
  url: string;
}

interface Token {
  access_token: string;
  refresh_token: string;
  expires_at: number;
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
  // Not an AuthError: `auth` itself needs these.
  if (!clientId || !clientSecret)
    throw new Error(
      `Freesound API credentials missing: put your client id and client secret in ${CONFIG}/client_id ` +
        `and ${CONFIG}/client_secret (chmod 600). Get them at https://freesound.org/apiv2/apply`,
    );
  return { clientId, clientSecret };
}

// Secrets go in CONFIG, readable only by the user.
function writePrivate(path: string, data: string): void {
  mkdirSync(CONFIG, { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
}

// Freesound requires PKCE (S256): the authorize link carries a hash of a one-time secret (the verifier),
// and the code exchange must send the secret itself. The verifier is kept in a private file in between.
const VERIFIER_FILE = join(CONFIG, "pkce_verifier");

export function authorizeUrl(): string {
  const { clientId } = credentials();
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  writePrivate(VERIFIER_FILE, verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${API}/oauth2/authorize/?${params}`;
}

async function tokenRequest(params: Record<string, string>): Promise<Token> {
  const { clientId, clientSecret } = credentials();
  const res = await fetch(`${API}/oauth2/access_token/`, {
    method: "POST",
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  if (!res.ok) throw new AuthError(`Freesound token request failed: HTTP ${res.status}`);
  const body = (await res.json()) as Omit<Token, "expires_at"> & { expires_in: number | string };
  const token: Token = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + (Number(body.expires_in) - 60) * 1000, // refresh a minute early
  };
  writePrivate(TOKEN_FILE, JSON.stringify(token, null, 2));
  return token;
}

/** Exchanges the code shown after authorizing (valid ~10 minutes) for a token, and saves it. */
export async function exchangeCode(code: string): Promise<void> {
  if (!existsSync(VERIFIER_FILE))
    throw new AuthError("no pending Freesound login: get a new authorize link first");
  const verifier = readFileSync(VERIFIER_FILE, "utf8").trim();
  await tokenRequest({
    grant_type: "authorization_code",
    code: code.trim(),
    code_verifier: verifier,
  });
  rmSync(VERIFIER_FILE, { force: true });
}

async function accessToken(): Promise<string> {
  if (!existsSync(TOKEN_FILE)) throw new AuthError("not logged in to Freesound");
  let token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as Token;
  // A rejected refresh is an AuthError from tokenRequest; network errors stay what they are.
  if (Date.now() >= token.expires_at)
    token = await tokenRequest({ grant_type: "refresh_token", refresh_token: token.refresh_token });
  return token.access_token;
}

// ---------- throttled requests ----------

let lastRequest = 0;

/** A GET request, spaced and retried within Freesound's rate limits. Throws unless the response is OK. */
async function throttled(url: string, what: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401) throw new AuthError("Freesound rejected the login");
    if (res.ok) return res;
    if (res.status !== 429) throw new Error(`${what}: HTTP ${res.status}`);

    // Freesound (Django REST framework) says why in the body, e.g. "... limit rate (500/day)", and how long
    // to wait in Retry-After. For the daily limit Retry-After is still ~60 s, which is useless: the limit is
    // a rolling 24 h window. So the body text is the only signal to stop at once; if its wording ever
    // changes, the attempt cap below still ends the retries, just later.
    const retryAfter = Number(res.headers.get("retry-after") ?? 60);
    const detail = await res
      .json()
      .then((b) => (b as { detail?: string }).detail ?? "")
      .catch(() => "");
    const message = `Freesound rate limit: ${detail || "too many requests"}`;
    if (/\/day\b/.test(detail))
      throw new Error(
        `${message}. That limit counts all of your Freesound account's API requests over a rolling ` +
          "24 hours. Progress is saved: run `pnpm test-samples` again later to download the rest.",
      );
    if (retryAfter > MAX_RETRY_WAIT_S || attempt === 3)
      throw new Error(
        `${message}. Progress is saved: run \`pnpm test-samples\` again in a few minutes.`,
      );
    console.warn(`  Freesound rate limit (${detail || "429"}), waiting ${retryAfter} s…`);
    await sleep(retryAfter * 1000);
  }
}

/**
 * Metadata of many sounds with one search request per 100 ids, so that the daily request limit goes to
 * downloads. Sounds missing from the result no longer exist on Freesound.
 */
export async function soundInfos(ids: number[]): Promise<Map<number, SoundInfo>> {
  const infos = new Map<number, SoundInfo>();
  for (let i = 0; i < ids.length; i += 100) {
    const params = new URLSearchParams({
      filter: `id:(${ids.slice(i, i + 100).join(" OR ")})`,
      fields: "id,name,username,license,type,url",
      page_size: "150",
    });
    const res = await throttled(
      `${API}/search/text/?${params}`,
      "Freesound search for sound metadata",
    );
    for (const info of ((await res.json()) as { results: SoundInfo[] }).results)
      infos.set(info.id, info);
  }
  return infos;
}

/** Streams the original file of a sound to dest and returns its sha256. The caller cleans up on failure. */
export async function downloadOriginal(id: number, dest: string): Promise<string> {
  const res = await throttled(
    `${API}/sounds/${id}/download/`,
    `Freesound sound ${id}: download failed`,
  );
  if (!res.body) throw new Error(`Freesound sound ${id}: download failed, empty response`);
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(dest),
  );
  return hash.digest("hex");
}
