import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/** Configuration is deliberately small: this extension never invokes Pi's compactor. */
export interface PinnedContextConfig {
  maxContextPercent: number;
  minRecentTurns: number;
  maxRecentTurns?: number;
}

const DEFAULT_CONFIG: PinnedContextConfig = {
  maxContextPercent: 0.9,
  minRecentTurns: 20,
};
const CONFIG_FILE = join(homedir(), ".pi", "agent", "pinned-context.json");

type Message = AgentMessage & { role?: string; content?: unknown; [key: string]: unknown };
interface Turn { messages: Message[]; tokens: number; }
interface TurnSnapshot {
  index: number;
  tokens: number;
  retained: boolean;
  roleCounts: Record<string, number>;
}
interface Snapshot {
  contextWindow: number; pinnedTokens: number; conversationTokens: number;
  retainedTurns: number; droppedTurns: number; totalTokens: number;
  turns: TurnSnapshot[];
}

function loadConfig(): PinnedContextConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (!value || typeof value !== "object") return DEFAULT_CONFIG;
    const v = value as Record<string, unknown>;
    return {
      maxContextPercent: typeof v.maxContextPercent === "number" && Number.isFinite(v.maxContextPercent) && v.maxContextPercent >= 0.01 && v.maxContextPercent <= 1 ? v.maxContextPercent : DEFAULT_CONFIG.maxContextPercent,
      minRecentTurns: typeof v.minRecentTurns === "number" && Number.isInteger(v.minRecentTurns) && v.minRecentTurns >= 0 ? v.minRecentTurns : DEFAULT_CONFIG.minRecentTurns,
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
  let retained = config.maxRecentTurns === undefined
    ? turns.slice()
    : config.maxRecentTurns === 0
      ? []
      : turns.slice(-config.maxRecentTurns);

  // Remove complete oldest turns only. minRecentTurns is a floor, not a reason to split a turn.
  while (retained.length > config.minRecentTurns && pinnedTokens + retained.reduce((n, t) => n + t.tokens, 0) > budget) {
    retained.shift();
  }
  const result = [...pinned, ...retained.flatMap((t) => t.messages)];
  const retainedSet = new Set(retained);
  const turnSnapshots = turns.map((turn, index) => ({
    index: index + 1,
    tokens: turn.tokens,
    retained: retainedSet.has(turn),
    roleCounts: turn.messages.reduce<Record<string, number>>((counts, message) => {
      const role = message.role ?? "unknown";
      counts[role] = (counts[role] ?? 0) + 1;
      return counts;
    }, {}),
  }));
  const snapshot: Snapshot = {
    contextWindow, pinnedTokens, conversationTokens: retained.reduce((n, t) => n + t.tokens, 0),
    retainedTurns: retained.length, droppedTurns: turns.length - retained.length,
    totalTokens: pinnedTokens + retained.reduce((n, t) => n + t.tokens, 0),
    turns: turnSnapshots,
  };
  return { messages: result, snapshot };
}

function contextWindow(ctx: ExtensionContext): number {
  const model = ctx.model as (typeof ctx.model & { contextWindow?: number }) | undefined;
  const value = ctx.getContextUsage()?.contextWindow ?? model?.contextWindow;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 128_000;
}
function format(s: Snapshot): string {
  const usagePercent = s.contextWindow > 0 ? (s.totalTokens / s.contextWindow * 100).toFixed(1) : "unknown";
  const tableRows = s.turns.map((turn) => [
    String(turn.index),
    turn.tokens.toLocaleString(),
    turn.retained ? "USED" : "DROPPED",
    Object.entries(turn.roleCounts).map(([role, count]) => `${role}=${count}`).join(" "),
  ]);
  const headers = ["Turn", "Tokens", "Status", "Messages"];
  const widths = headers.map((header, index) => Math.max(header.length, ...tableRows.map((row) => row[index].length)));
  const line = `+-${widths.map((width) => "-".repeat(width)).join("-+-")}-+`;
  const row = (values: string[]): string => `| ${values.map((value, index) => value.padEnd(widths[index])).join(" | ")} |`;
  const table = [line, row(headers), line, ...tableRows.map(row), line];
  if (tableRows.length === 0) table.splice(3, 0, "| No conversational turns".padEnd(line.length - 1) + "|");
  return [
    `Context window: ${s.contextWindow.toLocaleString()}`,
    `Token usage: ${s.totalTokens.toLocaleString()} (${usagePercent}%)`,
    `Pinned tokens: ${s.pinnedTokens.toLocaleString()}`,
    `Conversation tokens: ${s.conversationTokens.toLocaleString()}`,
    `Turns currently in context: ${s.retainedTurns}`,
    `Dropped turns: ${s.droppedTurns}`,
    "",
    ...table,
  ].join("\n");
}

export default function pinnedContext(pi: ExtensionAPI): void {
  let config = loadConfig();
  let minRecentTurnsOverride: number | undefined;
  let maxRecentTurnsOverride: number | undefined;
  let last: Snapshot | undefined;

  pi.on("context_with_system", async (event, ctx) => {
    config = loadConfig();
    const minRecentTurns = maxRecentTurnsOverride ?? minRecentTurnsOverride ?? config.minRecentTurns;
    const input = event.messages as Message[];
    const output = prune(input, contextWindow(ctx), {
      ...config,
      minRecentTurns,
      maxRecentTurns: maxRecentTurnsOverride,
    });
    last = output.snapshot;
    return { messages: output.messages as AgentMessage[] };
  });

  pi.registerCommand("pinned-context-status", {
    description: "Show pinned-prefix sliding-context statistics",
    handler: async (_args, ctx) => {
      if (!last) {
        const messages = ctx.sessionManager.buildSessionContext().messages as Message[];
        const preview = prune(messages, contextWindow(ctx), {
          ...config,
          minRecentTurns: maxRecentTurnsOverride ?? minRecentTurnsOverride ?? config.minRecentTurns,
          maxRecentTurns: maxRecentTurnsOverride,
        });
        ctx.ui.notify(`${format(preview.snapshot)}\n\nNo model request has been filtered yet; this is a preview.`, "info");
        return;
      }
      ctx.ui.notify(format(last), "info");
    },
  });
  pi.registerCommand("pinned-context-min-turns", {
    description: "Set the minimum retained turns for this session",
    handler: async (args, ctx) => {
      const text = args.trim();
      const value = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
        ctx.ui.notify("Usage: /pinned-context-min-turns <non-negative integer>", "warning");
        return;
      }
      minRecentTurnsOverride = value;
      maxRecentTurnsOverride = undefined;
      ctx.ui.notify(`Minimum retained turns set to ${value} for this session.`, "info");
    },
  });
  pi.registerCommand("pinned-context-set-turns", {
    description: "Keep exactly this many most recent turns for this session",
    handler: async (args, ctx) => {
      const text = args.trim();
      const value = Number(text);
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
        ctx.ui.notify("Usage: /pinned-context-set-turns <non-negative integer>", "warning");
        return;
      }
      maxRecentTurnsOverride = value;
      minRecentTurnsOverride = undefined;
      ctx.ui.notify(`Context limited to the ${value} most recent turns for this session.`, "info");
    },
  });
}
