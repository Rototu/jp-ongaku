import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_FILE } from '../paths';
import { getSetting } from '../db';
import type { LlmStatus } from '../../shared/types';

/**
 * LLM backend for the explanation layer: Vercel AI Gateway over HTTP.
 *
 * One transport, any model — the gateway exposes every provider behind the same
 * OpenAI-shaped endpoint, so switching models is a settings change rather than a
 * code change.
 *
 * Without a key the app runs dictionary-only: readings, romaji, furigana,
 * meanings, cards and the whole SRS still work, and every caller degrades
 * rather than failing.
 */

export type ProviderName = 'gateway' | 'none';

interface FileConfig {
  gatewayApiKey?: string;
  gatewayModel?: string;
}

function fileConfig(): FileConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as FileConfig;
  } catch {
    return {};
  }
}

export interface ResolvedProvider {
  name: ProviderName;
  apiKey?: string;
  model: string;
  /**
   * How much internal reasoning to allow. Reasoning models otherwise spend most
   * of a request thinking: measured on deepseek-v4-flash, one batch took 43s
   * with 3,088 reasoning tokens versus 12s and zero at 'none' — and the thinking
   * pushed the real answer past the token ceiling, truncating the JSON.
   */
  reasoningEffort: ReasoningEffort;
  /** Batches requested at once. */
  concurrency: number;
}

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'default';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';
const DEFAULT_REASONING: ReasoningEffort = 'none';
const DEFAULT_CONCURRENCY = 4;
const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';

function readEffort(): ReasoningEffort {
  const raw = getSetting('reasoning_effort');
  const allowed: ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'default'];
  return allowed.includes(raw as ReasoningEffort) ? (raw as ReasoningEffort) : DEFAULT_REASONING;
}

function readConcurrency(): number {
  const raw = Number(getSetting('llm_concurrency'));
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_CONCURRENCY;
  return Math.min(Math.floor(raw), 8);
}

export function resolveProvider(): ResolvedProvider {
  const cfg = fileConfig();
  const apiKey =
    getSetting('gateway_api_key') ?? cfg.gatewayApiKey ?? process.env.AI_GATEWAY_API_KEY ?? undefined;
  const model = getSetting('gateway_model') ?? cfg.gatewayModel ?? DEFAULT_MODEL;
  const reasoningEffort = readEffort();
  const concurrency = readConcurrency();

  // An explicit "off" wins, so the user can force dictionary-only mode while
  // leaving their key in place.
  if (getSetting('llm_provider') === 'none') {
    return { name: 'none', apiKey, model, reasoningEffort, concurrency };
  }

  return { name: apiKey ? 'gateway' : 'none', apiKey, model, reasoningEffort, concurrency };
}

export function status(): LlmStatus {
  const p = resolveProvider();
  if (p.name === 'gateway') {
    return {
      provider: 'gateway',
      available: true,
      detail: `Using Vercel AI Gateway (${p.model})`,
    };
  }
  return {
    provider: 'none',
    available: false,
    detail: getSetting('gateway_api_key')
      ? 'AI layer turned off — dictionary-only mode'
      : 'No API key set. Dictionary-only: readings, romaji and glosses, no AI explanations',
  };
}

export class LlmUnavailable extends Error {}

const TIMEOUT_MS = 180_000;
/** Retries for transient transport failures (429, 5xx, network blips). */
const MAX_ATTEMPTS = 4;
/** Backoff per attempt. Generous, because 429 means "you are asking too fast". */
const BACKOFF_MS = [2_000, 6_000, 15_000];
/** Enough room that a full batch of explanations never truncates. */
const MAX_OUTPUT_TOKENS = 16_384;

/**
 * Shared rate-limit gate.
 *
 * With several batches in flight, a 429 means every worker should back off, not
 * just the one that got it — otherwise the others keep hammering and the limit
 * never clears. Setting a cooldown here parks all of them until it passes.
 */
let cooldownUntil = 0;

function noteCooldown(ms: number): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

async function waitForCooldown(): Promise<void> {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

/** Test hook: clears the shared cooldown between cases. */
export function _resetRateLimitGate(): void {
  cooldownUntil = 0;
}

/**
 * Pulls the human-readable message out of a gateway error body.
 * The gateway's own wording is more actionable than anything invented here —
 * it names the model, the tier, and what to do about it.
 */
function gatewayMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed.error?.message?.trim();
    return message ? decodeURIComponent(message) : null;
  } catch {
    return null;
  }
}

/** Honours Retry-After when the gateway sends it, in seconds or as a date. */
function retryDelay(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      const wait = date - Date.now();
      if (wait > 0) return Math.min(wait, 60_000);
    }
  }
  return BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
}

/**
 * Sends one prompt and returns the raw text response.
 * Throws LlmUnavailable when no key is configured, so callers can tell
 * "not set up" apart from "the call failed".
 */
export async function complete(prompt: string, system?: string): Promise<string> {
  const p = resolveProvider();
  if (p.name === 'none' || !p.apiKey) {
    throw new LlmUnavailable('no API key configured for the AI Gateway');
  }

  const messages: { role: string; content: string }[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Respect a cooldown another in-flight request may have triggered.
      await waitForCooldown();
      const res = await fetch(GATEWAY_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${p.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: p.model,
          messages,
          // Low temperature: this is extraction and explanation, not creative
          // writing, and the user cares about consistency.
          temperature: 0.2,
          // Headroom so a verbose answer is never cut off mid-JSON. Truncation
          // used to surface as an unparseable response and a wasted retry.
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(p.reasoningEffort === 'default'
            ? {}
            : { reasoning_effort: p.reasoningEffort }),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text();
        // Prefer the gateway's own wording; fall back to the raw body.
        const detail = gatewayMessage(body) ?? body.slice(0, 300);
        const err = new Error(`AI Gateway ${res.status}: ${detail}`);

        // Auth and malformed-request errors will not fix themselves.
        if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 404) {
          throw err;
        }
        lastError = err;
        const delay = retryDelay(res, attempt);
        // A 429 applies to the whole key, so park every other worker too.
        if (res.status === 429) noteCooldown(delay);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(delay);
          continue;
        }
        throw err;
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const choice = json.choices?.[0];
      const text = choice?.message?.content;
      if (!text) throw new Error('AI Gateway returned no content');
      // Truncated output is unparseable JSON. Say so plainly instead of letting
      // it surface as a mysterious parse failure downstream.
      if (choice?.finish_reason === 'length') {
        throw new Error(
          'AI Gateway 200: the model hit its output limit and the reply was cut off. Lower the reasoning effort or use a model with more output room.',
        );
      }
      return text;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // Match only the status prefix this function produces, so a status code
      // appearing inside a provider's prose cannot be mistaken for a real one.
      const fatal = /^AI Gateway (400|401|403|404):/.test(message) || /no content/.test(message);
      if (fatal || attempt === MAX_ATTEMPTS) throw err;
      await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('AI Gateway request failed');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts a JSON value from a model response, tolerating prose or code fences
 * around it.
 */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text].filter((x): x is string => !!x);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // Fall through to bracket scanning.
    }
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const openChar = trimmed[start];
    const closeChar = openChar === '[' ? ']' : '}';
    let depth = 0;
    let inStr = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === openChar) depth++;
      else if (c === closeChar) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error('no JSON found in model response');
}
