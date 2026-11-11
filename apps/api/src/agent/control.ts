/**
 * The agent's on/off switch, shared by the API (console), the live traders and the `fisika` CLI.
 *
 * One small JSON file holds a global switch and one switch per chain. A chain trades only when both are on. The file
 * is written atomically (temp file + rename) so a reader never sees half of it, and it lives in /var/lib/fisika, so it
 * survives restarts and redeploys. No file at all means Paused: a fresh install never trades until someone says so.
 *
 * Every change is also appended to the agent activity log, with who made it.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 'solana' is the meme desk's switch. */
export type ChainSwitchKey = 'celo' | 'bsc' | 'solana';
export const SWITCH_CHAINS: readonly ChainSwitchKey[] = ['celo', 'bsc', 'solana'];

export interface ControlState {
  active: boolean;
  chains: Record<ChainSwitchKey, boolean>;
  updatedAt: string | null;
  by: string | null;
}

export const PAUSED_DEFAULT: ControlState = { active: false, chains: { celo: true, bsc: true, solana: true }, updatedAt: null, by: null };

export const defaultControlFile = () => process.env.CONTROL_FILE ?? '/var/lib/fisika/control.json';
export const defaultEventsFile = (controlFile = defaultControlFile()) => process.env.AGENT_EVENTS_FILE ?? `${dirname(controlFile)}/agent-events.jsonl`;

function parse(raw: string): ControlState {
  const j = JSON.parse(raw) as Partial<ControlState>;
  return {
    active: j.active === true,
    chains: { celo: j.chains?.celo !== false, bsc: j.chains?.bsc !== false, solana: j.chains?.solana !== false },
    updatedAt: j.updatedAt ?? null,
    by: j.by ?? null,
  };
}

/** Synchronous read: the trader calls this right before every trade, so it must be cheap and never throw. */
export function readControlSync(file: string): ControlState {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch {
    return { ...PAUSED_DEFAULT, chains: { ...PAUSED_DEFAULT.chains } };
  }
}

export async function readControl(file: string): Promise<ControlState> {
  try {
    return parse(await readFile(file, 'utf8'));
  } catch {
    return { ...PAUSED_DEFAULT, chains: { ...PAUSED_DEFAULT.chains } };
  }
}

export function chainTrades(s: ControlState, chain: string): boolean {
  return s.active && s.chains[chain as ChainSwitchKey] !== false;
}

export type ControlTarget = 'all' | ChainSwitchKey;

/** Apply one change: target 'all' is the global switch, a chain key is that chain's switch. */
export async function setControl(file: string, target: ControlTarget, active: boolean, by: string, eventsFile = defaultEventsFile(file)): Promise<ControlState> {
  const cur = await readControl(file);
  const next: ControlState = { ...cur, chains: { ...cur.chains }, updatedAt: new Date().toISOString(), by };
  if (target === 'all') next.active = active;
  else next.chains[target] = active;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2));
  await rename(tmp, file);
  await logEvent(eventsFile, { type: active ? 'resume' : 'pause', chain: target, by });
  return next;
}

export interface AgentEvent {
  at: string;
  type: 'pause' | 'resume' | 'deposit' | 'withdraw_requested' | 'withdraw_sent' | 'withdraw_failed';
  chain: string;
  by?: string;
  token?: string;
  amount?: string;
  txHash?: string;
  id?: string;
  note?: string;
}

/** Append one line. Small O_APPEND writes are atomic, so the API, the traders and the CLI can all log here. */
export async function logEvent(file: string, e: Omit<AgentEvent, 'at'> & { at?: string }): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
}

export async function readEvents(file: string): Promise<AgentEvent[]> {
  try {
    return (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AgentEvent);
  } catch {
    return [];
  }
}
