import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The config dir (~/.config/freesound) is read at import, so home points at a fresh temp dir per test.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
// Waits advance the fake clock instantly, so request times show the spacing without slowing the tests.
vi.mock("node:timers/promises", () => ({
  setTimeout: async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
  },
}));

type Freesound = typeof import("./freesound.ts");

interface RecordedRequest {
  url: URL;
  at: number;
  authorization: string | null;
  form: URLSearchParams | null;
}

/** A fake Freesound API: answers with `respond`, or a default per endpoint, and records every request. */
function fakeFreesound(respond?: (req: RecordedRequest) => Response | undefined) {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const req: RecordedRequest = {
      url: new URL(input),
      at: Date.now(),
      authorization: new Headers(init?.headers).get("authorization"),
      form: init?.body instanceof URLSearchParams ? init.body : null,
    };
    requests.push(req);
    const custom = respond?.(req);
    if (custom) return custom;
    if (req.url.pathname === "/apiv2/oauth2/access_token/")
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86400,
      });
    if (req.url.pathname === "/apiv2/search/text/") {
      const ids = req.url.searchParams.get("filter")?.match(/\d+/g) ?? [];
      return Response.json({ results: ids.map((id) => ({ id: Number(id), name: `sound ${id}` })) });
    }
    const download = req.url.pathname.match(/^\/apiv2\/sounds\/(\d+)\/download\/$/);
    if (download) return new Response(`audio of ${download[1]}`);
    return new Response("not found", { status: 404 });
  });
  return requests;
}

const configDir = () => join(home.dir, ".config/freesound");

function saveToken(expiresAt: number) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(
    join(configDir(), "token.json"),
    JSON.stringify({
      access_token: "saved-access",
      refresh_token: "saved-refresh",
      expires_at: expiresAt,
    }),
  );
}

const rateLimited = (detail: string, retryAfter = 60) =>
  Response.json({ detail }, { status: 429, headers: { "Retry-After": String(retryAfter) } });

describe("freesound", () => {
  let freesound: Freesound;

  beforeEach(async () => {
    home.dir = mkdtempSync(join(tmpdir(), "freesound-spec-"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubEnv("FREESOUND_CLIENT_ID", "client-id");
    vi.stubEnv("FREESOUND_CLIENT_SECRET", "client-secret");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A fresh module per test, so the request spacing doesn't carry over between tests.
    vi.resetModules();
    freesound = await import("./freesound.ts");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(home.dir, { recursive: true, force: true });
  });

  describe("login", () => {
    it("exchanges the code with the PKCE verifier whose S256 hash is in the authorize link", async () => {
      const requests = fakeFreesound();

      const link = new URL(freesound.authorizeUrl());
      await freesound.exchangeCode(" the-code \n");

      expect(link.searchParams.get("code_challenge_method")).toBe("S256");
      const form = requests[0].form;
      expect(form?.get("grant_type")).toBe("authorization_code");
      expect(form?.get("code")).toBe("the-code");
      const verifier = form?.get("code_verifier") ?? "";
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
        link.searchParams.get("code_challenge"),
      );
    });

    it("uses the exchanged token for API requests", async () => {
      const requests = fakeFreesound();
      freesound.authorizeUrl();
      await freesound.exchangeCode("the-code");

      await freesound.soundInfos([1]);

      expect(requests.at(-1)?.authorization).toBe("Bearer new-access");
    });

    it("refreshes an expired token before a request and uses the new one", async () => {
      saveToken(Date.now() - 1);
      const requests = fakeFreesound();

      await freesound.soundInfos([1]);

      expect(requests[0].form?.get("grant_type")).toBe("refresh_token");
      expect(requests[0].form?.get("refresh_token")).toBe("saved-refresh");
      expect(requests[1].authorization).toBe("Bearer new-access");
    });

    it.each([
      ["not logged in", () => {}, /not logged in/],
      [
        "Freesound rejects the token",
        () => saveToken(Date.now() + 3_600_000),
        /rejected the login/,
      ],
      ["Freesound rejects the refresh", () => saveToken(Date.now() - 1), /token request failed/],
    ])("throws an AuthError when %s", async (_, arrange, message) => {
      arrange();
      fakeFreesound(() => new Response("{}", { status: 401 }));

      const result = freesound.soundInfos([1]);

      await expect(result).rejects.toThrow(freesound.AuthError);
      await expect(result).rejects.toThrow(message);
    });
  });

  describe("soundInfos", () => {
    it("fetches the metadata of 100 sounds per search request", async () => {
      saveToken(Date.now() + 3_600_000);
      const requests = fakeFreesound();
      const ids = Array.from({ length: 250 }, (_, i) => 1000 + i);

      const infos = await freesound.soundInfos(ids);

      const idsPerRequest = requests.map(
        (r) => r.url.searchParams.get("filter")?.match(/\d+/g)?.length,
      );
      expect(idsPerRequest).toEqual([100, 100, 50]);
      expect([...infos.keys()].sort()).toEqual(ids);
      expect(infos.get(1042)?.name).toBe("sound 1042");
    });

    it("leaves out sounds that Freesound no longer has", async () => {
      saveToken(Date.now() + 3_600_000);
      fakeFreesound(() => Response.json({ results: [{ id: 1, name: "kept" }] }));

      const infos = await freesound.soundInfos([1, 2]);

      expect([...infos.keys()]).toEqual([1]);
    });
  });

  describe("downloadOriginal", () => {
    it("writes the sound's original file to dest and returns its sha256", async () => {
      saveToken(Date.now() + 3_600_000);
      fakeFreesound();
      const dest = join(home.dir, "808.wav");

      const digest = await freesound.downloadOriginal(808, dest);

      expect(readFileSync(dest, "utf8")).toBe("audio of 808");
      expect(digest).toBe(createHash("sha256").update("audio of 808").digest("hex"));
    });

    it("throws when the download fails", async () => {
      saveToken(Date.now() + 3_600_000);
      fakeFreesound(() => new Response("gone", { status: 404 }));

      await expect(freesound.downloadOriginal(808, join(home.dir, "808.wav"))).rejects.toThrow(
        "Freesound sound 808: download failed: HTTP 404",
      );
    });
  });

  describe("rate limits", () => {
    beforeEach(() => saveToken(Date.now() + 3_600_000));

    it("spaces requests at least 2.1 s apart", async () => {
      const requests = fakeFreesound();

      for (const id of [1, 2, 3]) await freesound.downloadOriginal(id, join(home.dir, `${id}.wav`));

      const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(2100);
    });

    it("waits for Retry-After and retries when the per-minute limit is hit", async () => {
      let calls = 0;
      const requests = fakeFreesound(() =>
        ++calls === 1
          ? rateLimited("Request was throttled. Expected available in 45 seconds.", 45)
          : undefined,
      );

      const digest = await freesound.downloadOriginal(808, join(home.dir, "808.wav"));

      expect(digest).toBe(createHash("sha256").update("audio of 808").digest("hex"));
      expect(requests).toHaveLength(2);
      expect(requests[1].at - requests[0].at).toBeGreaterThanOrEqual(45_000);
    });

    it.each([
      [
        "the daily limit is hit, whatever Retry-After says",
        () => rateLimited("You have exceeded the download limit rate (500/day)", 60),
        1,
        /500\/day.*rolling 24 hours/,
      ],
      [
        "Retry-After is longer than two minutes",
        () => rateLimited("Request was throttled.", 600),
        1,
        /run `pnpm test-samples` again in a few minutes/,
      ],
      [
        "the limit is still hit after three attempts",
        () => rateLimited("Request was throttled.", 30),
        3,
        /run `pnpm test-samples` again in a few minutes/,
      ],
    ])("gives up when %s", async (_, respond, expectedRequests, message) => {
      const requests = fakeFreesound(respond);

      await expect(freesound.downloadOriginal(808, join(home.dir, "808.wav"))).rejects.toThrow(
        message,
      );
      expect(requests).toHaveLength(expectedRequests);
    });
  });
});
