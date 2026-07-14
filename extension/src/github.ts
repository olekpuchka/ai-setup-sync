import * as https from "https";

/** A single file entry from the GitHub git-tree API. */
export interface TreeEntry {
  /** Repo-relative path, e.g. ".claude/skills/b2c-docs/SKILL.md". */
  path: string;
  /** Git blob SHA (matches gitBlobSha() of the file content). */
  sha: string;
  /** "blob" for files, "tree" for directories. */
  type: string;
}

export interface RepoRef {
  repo: string;
  /** Full repository URL as configured in settings (e.g. https://github.com/owner/repo). */
  url: string;
  ref: string;
  token?: string;
}

const USER_AGENT = "ai-setup-sync";

/**
 * Returns the GitHub API base URL for a given repo URL.
 * github.com repos use `https://api.github.com`; GitHub Enterprise Server repos use `https://HOSTNAME/api/v3`.
 */
function apiBase(repoUrl: string): string {
  try {
    const { hostname } = new URL(repoUrl);
    return hostname === "github.com"
      ? "https://api.github.com"
      : `https://${hostname}/api/v3`;
  } catch {
    return "https://api.github.com";
  }
}

/** True when two URLs share the same origin (protocol + host + port). */
function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/** Encodes each segment of an `owner/name` slug for use in URLs. */
function encodeRepoSlug(repo: string): string {
  const slash = repo.indexOf("/");
  if (slash < 0) {
    return encodeURIComponent(repo);
  }
  return `${encodeURIComponent(repo.slice(0, slash))}/${encodeURIComponent(repo.slice(slash + 1))}`;
}

/** Thrown when the error is caused by a misconfigured repository URL (not a transient failure). */
export class ConfigError extends Error {
  needsToken?: boolean;
  /** The extension setting key to open when the user clicks "Open settings". Defaults to repository. */
  setting?: string;
  /** Machine-readable error kind for programmatic discrimination (not shown to users). */
  kind?: string;
  constructor(message: string, needsToken?: boolean, setting?: string, kind?: string) {
    super(message);
    this.name = "ConfigError";
    this.needsToken = needsToken;
    this.setting = setting;
    this.kind = kind;
  }
}

/** Thrown when GitHub rejects a request because the API rate limit is exhausted, or SSO authorization is required. */
export class RateLimitError extends Error {
  /** Epoch ms when the limit resets, from X-RateLimit-Reset (if provided). */
  resetAt?: number;
  /** True when the 403 was caused by missing SAML SSO authorization (not a rate limit). */
  isSso?: boolean;
  /** Authorization URL from X-GitHub-SSO header, when isSso is true. */
  ssoUrl?: string;
  constructor(message: string, resetAt?: number, isSso?: boolean, ssoUrl?: string) {
    super(message);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
    this.isSso = isSso;
    this.ssoUrl = ssoUrl;
  }
}

/** Thrown when a raw file fetch returns a non-2xx HTTP status. Carries the status for callers. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

type RequestResult = {
  status: number;
  body: Buffer;
  etag?: string;
  headers: Record<string, string | string[] | undefined>;
};

function request(url: string, headers: Record<string, string>): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => {
          chunks.push(c as Buffer);
          req.setTimeout(30000); // reset idle timer while data is flowing
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            etag: res.headers.etag,
            headers: res.headers,
          })
        );
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("GitHub request timed out")));
  });
}

/** Transient upstream/gateway statuses worth retrying (GitHub intermittently returns these). */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** `Retry-After` seconds → milliseconds, or null if the header is absent/invalid. */
function parseRetryAfterMs(headers: Record<string, string | string[] | undefined>): number | null {
  const seconds = Number(headers["retry-after"]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * How long to wait before retrying a 403/429, or null to not retry. Only a secondary
 * (abuse) rate limit — which GitHub signals with `Retry-After` — is retried, since it
 * clears quickly. Primary-quota exhaustion and hard 403s (SSO/permission) have no
 * `Retry-After` and can't clear in a useful window, so they fail fast instead. The
 * wait is capped so a single retry can't stall the sync for too long.
 */
function rateLimitRetryDelayMs(res: RequestResult): number | null {
  if (res.status !== 403 && res.status !== 429) {
    return null;
  }
  const ms = parseRetryAfterMs(res.headers);
  return ms === null ? null : Math.min(ms, 60000);
}

/** Retries transient network errors, transient 5xx gateway responses, and secondary rate-limit 403/429s. */
async function requestWithRetry(
  url: string,
  headers: Record<string, string>,
  maxRetries = 2
): Promise<RequestResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await request(url, headers);
      // GitHub intermittently 502/503/504s on raw/contents and tree fetches; these are
      // transient, so back off and retry rather than failing the whole sync.
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        await new Promise<void>((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 5000)));
        continue;
      }
      const rateLimitDelay = rateLimitRetryDelayMs(res);
      if (rateLimitDelay !== null && attempt < maxRetries) {
        await new Promise<void>((r) => setTimeout(r, Math.max(rateLimitDelay, 1000 * 2 ** attempt)));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise<void>((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
      }
    }
  }
  throw lastErr;
}

/** Builds a RateLimitError from response headers (used for 403/429). */
function rateLimitError(
  headers: Record<string, string | string[] | undefined>
): RateLimitError {
  // SAML SSO: GitHub returns 403 with X-GitHub-SSO pointing to the authorization URL.
  const sso = headers["x-github-sso"];
  if (sso) {
    const ssoUrl = String(sso).match(/url=(\S+)/)?.[1];
    const org = ssoUrl?.match(/\/orgs\/([^/]+)\/sso/)?.[1];
    const orgHint = org ? ` for the "${org}" organization` : ` for this organization`;
    return new RateLimitError(
      `GitHub SSO authorization required — authorize your token${orgHint}.`,
      undefined,
      true,
      ssoUrl
    );
  }
  // Secondary (abuse) rate limit: GitHub sends Retry-After, meaning "too many requests
  // at once". This is about burst concurrency, not quota — so don't suggest adding a token.
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs !== null) {
    return new RateLimitError(
      `GitHub is throttling requests (too many at once). Try syncing again in a moment.`,
      Date.now() + retryAfterMs
    );
  }
  const reset = Number(headers["x-ratelimit-reset"]);
  const resetAt = reset ? reset * 1000 : undefined;
  const when = resetAt
    ? ` Resets at ${new Date(resetAt).toLocaleTimeString()}.`
    : "";
  return new RateLimitError(
    `GitHub API rate limit reached or access denied.${when} Add a personal access token to raise the limit.`,
    resetAt
  );
}

function authHeaders(token?: string): Record<string, string> {
  return token && token.trim().length >= 20 ? { Authorization: `Bearer ${token.trim()}` } : {};
}

/**
 * GETs a GitHub API resource with optional conditional-request support.
 * When `etag` is supplied and the resource is unchanged, GitHub answers `304`
 * with an empty body — which does NOT count against the API rate limit — and we
 * return `{ notModified: true }`.
 */
async function getJson(
  url: string,
  token?: string,
  etag?: string,
  redirectsLeft = 3
): Promise<{ data?: any; etag?: string; notModified: boolean }> {
  const { status, body, etag: newEtag, headers } = await requestWithRetry(url, {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(etag ? { "If-None-Match": etag } : {}),
    ...authHeaders(token),
  });
  if (status === 304) {
    return { notModified: true, etag };
  }
  if (status >= 301 && status <= 308) {
    const location = headers["location"];
    if (location && redirectsLeft > 0) {
      // Resolve relative Location against the current URL, and drop the token when
      // the redirect crosses to a different origin — never forward credentials to a
      // host we didn't authenticate to (SEC: cross-host auth leak on redirect).
      const nextUrl = new URL(String(location), url).toString();
      const nextToken = sameOrigin(url, nextUrl) ? token : undefined;
      return getJson(nextUrl, nextToken, etag, redirectsLeft - 1);
    }
    throw new ConfigError(
      `The repository may have been renamed or moved. Update the repository URL in extension settings.`
    );
  }
  if (status === 401) {
    throw new ConfigError(`GitHub token is invalid or expired.`, true);
  }
  if (status === 403 || status === 429) {
    throw rateLimitError(headers);
  }
  if (status === 404) {
    if (!token) {
      throw new ConfigError(
        `Repository not found. If this is a private repo, SSO-protected org, or GitHub Enterprise Server instance, set a GitHub token with the \`repo\` scope.`,
        true,
        undefined,
        "not-found"
      );
    }
    throw new ConfigError(
      `Repository not found. Check the repository URL in extension settings, and verify your token has the \`repo\` scope.`,
      undefined,
      undefined,
      "not-found"
    );
  }
  if (status < 200 || status >= 300) {
    throw new Error(`GitHub API returned HTTP ${status} for ${url}`);
  }
  return { data: JSON.parse(body.toString("utf8")), etag: newEtag, notModified: false };
}

interface TreeResult {
  entries: TreeEntry[];
  etag?: string;
  /** True when the tree is unchanged since the supplied etag (HTTP 304). */
  notModified: boolean;
}

/**
 * Lists every file in the repo at `ref` with its git blob SHA, via the recursive
 * trees API (one request for the whole tree). Pass the previous `etag` to get a
 * cheap `304` (and `notModified: true`) when nothing changed.
 */
export async function getTree(
  { repo, ref, token, url: repoUrl }: RepoRef,
  etag?: string
): Promise<TreeResult> {
  const base = apiBase(repoUrl);
  const url = `${base}/repos/${encodeRepoSlug(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  let res: Awaited<ReturnType<typeof getJson>>;
  try {
    res = await getJson(url, token, etag);
  } catch (err) {
    if (err instanceof ConfigError && err.kind === "not-found") {
      // Follow-up call to distinguish branch vs repo URL vs token issue.
      try {
        await getJson(`${base}/repos/${encodeRepoSlug(repo)}`, token);
        // Repo returned 200 — it exists, so the branch is the problem.
        throw new ConfigError(
          `Branch "${ref}" not found — check the branch name in settings.`,
          false,
          "aiSetupSync.branch"
        );
      } catch (repoErr) {
        if (!(repoErr instanceof ConfigError)) throw err; // RateLimitError or network error — can't distinguish branch vs repo, surface original not-found
        if (repoErr.setting === "aiSetupSync.branch") throw repoErr; // branch error we just created
        // Repo check also failed — either no token or wrong URL.
        if (repoErr.needsToken) {
          throw new ConfigError(
            `Repository not found — set a GitHub token with the \`repo\` scope for private repos, SSO-protected orgs, and GitHub Enterprise Server.`,
            true
          );
        }
        throw new ConfigError(
          `Repository not found — check the repository URL in settings.`,
          false,
          "aiSetupSync.repository"
        );
      }
    }
    throw err;
  }
  if (res.notModified) {
    return { entries: [], etag: res.etag, notModified: true };
  }
  if (res.data.truncated) {
    throw new Error(
      "The repository tree is too large for a single request (GitHub truncated it). Consider narrowing the synced folders."
    );
  }
  return {
    entries: (res.data.tree as TreeEntry[]).filter((e) => e.type === "blob"),
    etag: res.etag,
    notModified: false,
  };
}

/** Fetches a single file's raw bytes. */
export async function getRawFile(
  { repo, ref, token, url: repoUrl }: RepoRef,
  path: string
): Promise<Buffer> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  let url: string;
  let requestHeaders: Record<string, string>;
  if (token) {
    // Authenticated path (works for private repos and GitHub Enterprise Server): contents API with raw accept.
    url = `${apiBase(repoUrl)}/repos/${encodeRepoSlug(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    requestHeaders = {
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
      ...authHeaders(token),
    };
  } else {
    // Unauthenticated raw access is only available on github.com.
    const { hostname } = new URL(repoUrl);
    if (hostname !== "github.com") {
      throw new ConfigError(
        `A GitHub token is required to sync from GitHub Enterprise Server (${hostname}). Set a token with the \`repo\` scope.`,
        true
      );
    }
    url = `https://raw.githubusercontent.com/${encodeRepoSlug(repo)}/${encodeURIComponent(ref)}/${encodedPath}`;
    requestHeaders = {};
  }
  const { status, body, headers } = await requestWithRetry(url, requestHeaders);
  if (status === 403 || status === 429) {
    throw rateLimitError(headers);
  }
  if (status < 200 || status >= 300) {
    throw new HttpError(status, `Failed to fetch ${path} (HTTP ${status}).`);
  }
  return body;
}

