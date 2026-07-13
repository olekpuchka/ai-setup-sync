import * as vscode from "vscode";

const SECRET_KEY = "githubToken";
// The GitHub host a saved token is authorized for. Not sensitive (it's just a
// hostname), so it lives in globalState rather than SecretStorage. A token is
// only ever sent to this host — see tokenAllowedForHost in extension.ts.
const HOST_KEY = "aiSetupSync.githubTokenHost";

export async function getToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const token = await context.secrets.get(SECRET_KEY);
  return token || undefined;
}

/** The host the saved token was bound to, or undefined for a legacy/unbound token. */
export function getTokenHost(context: vscode.ExtensionContext): string | undefined {
  return context.globalState.get<string>(HOST_KEY) || undefined;
}

/**
 * Stores the token and binds it to `host` (the GitHub host it was configured for).
 * A classic PAT authenticates to exactly one GitHub deployment, so binding to a
 * single host loses no functionality while preventing the token from being sent
 * to any other host. Pass `undefined` when no repository host is known yet.
 */
export async function setToken(
  context: vscode.ExtensionContext,
  token: string,
  host?: string
): Promise<void> {
  await context.secrets.store(SECRET_KEY, token);
  await context.globalState.update(HOST_KEY, host);
}

export async function deleteToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  await context.globalState.update(HOST_KEY, undefined);
}
