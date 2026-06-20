import * as vscode from "vscode";

// A single shared output channel for diagnosing sync / update / cleanup activity.
// Created once on activation; log() is a no-op until then.

let channel: vscode.OutputChannel | undefined;

export function initOutput(context: vscode.ExtensionContext): void {
  if (!channel) {
    channel = vscode.window.createOutputChannel("AI Setup Sync");
    context.subscriptions.push(channel);
  }
}

export function showOutput(): void {
  channel?.show(true);
}

export function log(message: string): void {
  if (!channel) {
    return;
  }
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  channel.appendLine(`[${ts}] ${message}`);
}
