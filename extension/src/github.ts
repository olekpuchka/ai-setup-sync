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
  constructor(message: string, needsToken?: boolean) {
    super(message);
    this.name = "ConfigError";
    this.needsToken = needsToken;
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

/** Retries on transient network errors (not on HTTP-level failures). */
async function requestWithRetry(
  url: string,
  headers: Record<string, string>,
  maxRetries = 2
): Promise<RequestResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await request(url, headers);
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
    return new RateLimitError(
      `GitHub SSO authorization required — authorize your token for this organization.`,
      undefined,
      true,
      ssoUrl
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
      return getJson(String(location), token, etag, redirectsLeft - 1);
    }
    throw new ConfigError(
      `The repository may have been renamed or moved. Update the repository URL in extension settings.`
    );
  }
  if (status === 401) {
    throw new ConfigError(`Invalid GitHub token. Update it via the "Set GitHub Token" command.`, true);
  }
  if (status === 403 || status === 429) {
    throw rateLimitError(headers);
  }
  if (status === 404) {
    if (!token) {
      throw new ConfigError(
        `Repository not found. If this is a private repository, set a GitHub token with the \`repo\` scope.`,
        true
      );
    }
    throw new ConfigError(`Repository not found. Check the repository URL in extension settings, and verify your token has the \`repo\` scope.`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`GitHub API returned HTTP ${status} for ${url}`);
  }
  return { data: JSON.parse(body.toString("utf8")), etag: newEtag, notModified: false };
}

export interface TreeResult {
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
  { repo, ref, token }: RepoRef,
  etag?: string
): Promise<TreeResult> {
  const url = `https://api.github.com/repos/${encodeRepoSlug(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const res = await getJson(url, token, etag);
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
  { repo, ref, token }: RepoRef,
  path: string
): Promise<Buffer> {
  if (token) {
    // Authenticated path (works for private repos): contents API with raw accept.
    const url = `https://api.github.com/repos/${encodeRepoSlug(repo)}/contents/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?ref=${encodeURIComponent(ref)}`;
    const { status, body } = await requestWithRetry(url, {
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
      ...authHeaders(token),
    });
    if (status < 200 || status >= 300) {
      throw new Error(`Failed to fetch ${path} (HTTP ${status}).`);
    }
    return body;
  }
  const url = `https://raw.githubusercontent.com/${encodeRepoSlug(repo)}/${encodeURIComponent(ref)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const { status, body } = await requestWithRetry(url, {});
  if (status < 200 || status >= 300) {
    throw new Error(`Failed to fetch ${path} (HTTP ${status}).`);
  }
  return body;
}

