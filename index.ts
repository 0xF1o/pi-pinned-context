import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** Configuration is deliberately small: this extension never invokes Pi's compactor. */
export interface PinnedContextConfig {
  maxContextPercent: number;
  minRecentTurns: number;
  debugLogging: boolean;
}

const DEFAULT_CONFIG: PinnedContextConfig = {
  maxContextPercent: 0.9,
  minRecentTurns: 20,
  debugLogging: false,
};
const CONFIG_FILE = join(homedir(), ".pi", "agent", "pinned-context.json");

type Message = AgentMessage & { role?: string; content?: unknown; [key: string]: unknown };
interface Turn { messages: Message[]; tokens: number; }
interface Snapshot {
  contextWindow: number; pinnedTokens: number; conversationTokens: number;
  retainedTurns: number; droppedTurns: number; totalTokens: number;
}

function loadConfig(): PinnedContextConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (!value || typeof value !== "object") return DEFAULT_CONFIG;
    const v = value as Record<string, unknown>;
    return {
      maxContextPercent: typeof v.maxContextPercent === "number" && Number.isFinite(v.maxContextPercent) && v.maxContextPercent >= 0.01 && v.maxContextPercent <= 1 ? v.maxContextPercent : DEFAULT_CONFIG.maxContextPercent,
      minRecentTurns: typeof v.minRecentTurns === "number" && Number.isInteger(v.minRecentTurns) && v.minRecentTurns >= 0 ? v.minRecentTurns : DEFAULT_CONFIG.minRecentTurns,
      debugLogging: typeof v.debugLogging === "boolean" ? v.debugLogging : DEFAULT_CONFIG.debugLogging,
    };
  } catch { return DEFAULT_CONFIG; }
}

/** A provider-neutral, intentionally conservative estimate (4 chars/token plus overhead). */
function estimate(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / 4);
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.reduce((n, x) => n + estimate(x), 0);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>)
    .reduce<number>((n, x) => n + estimate(x), 0);
  return 1;
}

/**
 * Estimate the content Pi will expose to the provider, rather than counting the entire
 * AgentMessage object (timestamps, usage, and provider metadata are not prompt content).
 */
function messageTokens(message: Message): number {
  switch (message.role) {
    case "bashExecution":
      return 4 + estimate({ command: message.command, output: message.output });
    case "branchSummary":
    case "compactionSummary":
      return 4 + estimate(message.summary);
    default:
      return 4 + estimate(message.content);
  }
}

const CONVERSATIONAL_ROLES = new Set([
  "user", "assistant", "toolResult", "custom", "bashExecution", "branchSummary", "compactionSummary",
]);

function isPinned(message: Message): boolean {
  // Pi converts the non-system coding-agent messages to provider-facing user messages.
  // Keep only system messages (and genuinely unknown extension roles) in the pinned prefix.
  return !CONVERSATIONAL_ROLES.has(message.role ?? "");
}

function startsTurn(message: Message): boolean {
  return ["user", "custom", "bashExecution", "branchSummary", "compactionSummary"].includes(message.role ?? "");
}

/** Form turns at user boundaries. Tool calls and their results remain in one complete turn. */
function makeTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (!turns.length || startsTurn(message)) turns.push({ messages: [], tokens: 0 });
    const turn = turns[turns.length - 1];
    turn.messages.push(message);
    turn.tokens += messageTokens(message);
  }
  return turns.filter((turn) => turn.messages.length > 0);
}

function prune(messages: Message[], contextWindow: number, config: PinnedContextConfig): { messages: Message[]; snapshot: Snapshot } {
  const pinned = messages.filter(isPinned);
  const conversation = messages.filter((message) => !isPinned(message));
  const pinnedTokens = pinned.reduce((n, m) => n + messageTokens(m), 0);
  const turns = makeTurns(conversation);
  const budget = Math.max(1, Math.floor(contextWindow * config.maxContextPercent));
  let retained = turns.slice();

  // Remove complete oldest turns only. minRecentTurns is a floor, not a reason to split a turn.
  while (retained.length > config.minRecentTurns && pinnedTokens + retained.reduce((n, t) => n + t.tokens, 0) > budget) {
    retained.shift();
  }
  const result = [...pinned, ...retained.flatMap((t) => t.messages)];
  const snapshot: Snapshot = {
    contextWindow, pinnedTokens, conversationTokens: retained.reduce((n, t) => n + t.tokens, 0),
    retainedTurns: retained.length, droppedTurns: turns.length - retained.length,
    totalTokens: pinnedTokens + retained.reduce((n, t) => n + t.tokens, 0),
  };
  return { messages: result, snapshot };
}

function contextWindow(ctx: ExtensionContext): number {
  const model = ctx.model as (typeof ctx.model & { contextWindow?: number }) | undefined;
  const value = ctx.getContextUsage()?.contextWindow ?? model?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 128_000;
}
function format(s: Snapshot): string {
  return [`Context window: ${s.contextWindow.toLocaleString()}`, `Token usage: ${s.totalTokens.toLocaleString()}`,
    `Pinned tokens: ${s.pinnedTokens.toLocaleString()}`, `Conversation tokens: ${s.conversationTokens.toLocaleString()}`,
    `Retained turns: ${s.retainedTurns}`, `Dropped turns: ${s.droppedTurns}`].join("\n");
}

export default function pinnedContext(pi: ExtensionAPI): void {
  let config = loadConfig();
  let debugOverride: boolean | undefined;
  let last: Snapshot | undefined;

  const log = (s: Snapshot, debug: boolean): void => {
    if (debug) console.error(`[PinnedContext]\nPinned tokens: ${s.pinnedTokens}\nConversation tokens: ${s.conversationTokens}\nDropped turns: ${s.droppedTurns}\nRetained turns: ${s.retainedTurns}`);
  };

  pi.on("context_with_system", async (event, ctx) => {
    config = loadConfig();
    const debug = debugOverride ?? config.debugLogging;
    const input = event.messages as Message[];
    const output = prune(input, contextWindow(ctx), { ...config, debugLogging: debug });
    last = output.snapshot;
    log(last, debug);
    return { messages: output.messages as AgentMessage[] };
  });

  pi.registerCommand("pinned-context-status", {
    description: "Show pinned-prefix sliding-context statistics",
    handler: async (_args, ctx) => {
      if (!last) {
        const usage = ctx.getContextUsage();
        ctx.ui.notify(usage ? `Context window: ${usage.contextWindow.toLocaleString()}\nCurrent usage: ${usage.tokens ?? "unknown"}\nNo request has been filtered yet.` : "No model request has been filtered yet.", "info");
        return;
      }
      ctx.ui.notify(format(last), "info");
    },
  });
  pi.registerCommand("pinned-context-debug", {
    description: "Enable or disable pinned-context debug logging",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value !== "on" && value !== "off") { ctx.ui.notify("Usage: /pinned-context-debug on|off", "warning"); return; }
      debugOverride = value === "on";
      ctx.ui.notify(`Pinned-context debug logging ${debugOverride ? "enabled" : "disabled"}.`, "info");
    },
  });
}
