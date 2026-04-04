/**
 * Payload field extraction for notify-hook.
 */

import { asNumber, safeString, clampPct } from './utils.js';

export const LANGUAGE_REMINDER_MARKER = '[OMX_LANG_REMINDER]';
export const LANGUAGE_REMINDER_TEXT = `${LANGUAGE_REMINDER_MARKER} User input includes non-Latin script. Continue in the user's language.`;

type JsonObject = Record<string, unknown>;

export interface SessionTokenUsage {
  input: number | null;
  inputCumulative: boolean;
  output: number | null;
  outputCumulative: boolean;
  total: number | null;
  totalCumulative: boolean;
}

export interface QuotaUsage {
  fiveHourLimitPct: number | null;
  weeklyLimitPct: number | null;
}

interface PromptContext {
  mode: string;
  threadId: string;
  turnId: string;
  timestamp: string;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === 'object' ? value as JsonObject : {};
}

export function extractLimitPct(limit: unknown): number | null {
  if (limit == null) return null;
  if (typeof limit === 'number' || typeof limit === 'string') return clampPct(asNumber(limit));
  if (typeof limit !== 'object') return null;
  const record = asRecord(limit);

  const directPct = clampPct(asNumber(record.percent ?? record.pct ?? record.usage_percent ?? record.usagePct));
  if (directPct !== null) return directPct;

  const used = asNumber(record.used ?? record.usage ?? record.current);
  const max = asNumber(record.limit ?? record.max ?? record.total);
  if (used !== null && max !== null && max > 0) {
    return clampPct((used / max) * 100);
  }

  const remaining = asNumber(record.remaining ?? record.left);
  if (remaining !== null && max !== null && max > 0) {
    return clampPct(((max - remaining) / max) * 100);
  }

  return null;
}

export function getSessionTokenUsage(payload: unknown): SessionTokenUsage | null {
  const payloadRecord = asRecord(payload);
  const usage = asRecord(payloadRecord.usage ?? payloadRecord['usage'] ?? payloadRecord.token_usage ?? payloadRecord['token-usage']);

  function firstTokenMatch(candidates: Array<readonly [unknown, boolean]>): { value: number | null; cumulative: boolean } {
    for (const [raw, cumulative] of candidates) {
      const value = asNumber(raw);
      if (value !== null) return { value, cumulative };
    }
    return { value: null, cumulative: false };
  }

  const inputMatch = firstTokenMatch([
    [usage.session_input_tokens, true],
    [usage.input_tokens, false],
    [usage.total_input_tokens, true],
    [usage.prompt_tokens, false],
    [usage.promptTokens, false],
    [payloadRecord.session_input_tokens, true],
    [payloadRecord.input_tokens, false],
    [payloadRecord.total_input_tokens, true],
    [payloadRecord.prompt_tokens, false],
    [payloadRecord.promptTokens, false],
  ]);
  const outputMatch = firstTokenMatch([
    [usage.session_output_tokens, true],
    [usage.output_tokens, false],
    [usage.total_output_tokens, true],
    [usage.completion_tokens, false],
    [usage.completionTokens, false],
    [payloadRecord.session_output_tokens, true],
    [payloadRecord.output_tokens, false],
    [payloadRecord.total_output_tokens, true],
    [payloadRecord.completion_tokens, false],
    [payloadRecord.completionTokens, false],
  ]);
  const totalMatch = firstTokenMatch([
    [usage.session_total_tokens, true],
    [usage.total_tokens, true],
    [payloadRecord.session_total_tokens, true],
    [payloadRecord.total_tokens, true],
  ]);

  const input = inputMatch.value;
  const output = outputMatch.value;
  const total = totalMatch.value;

  if (input === null && output === null && total === null) return null;

  return {
    input,
    inputCumulative: inputMatch.cumulative,
    output,
    outputCumulative: outputMatch.cumulative,
    total,
    totalCumulative: totalMatch.cumulative,
  };
}

export function getQuotaUsage(payload: unknown): QuotaUsage | null {
  const payloadRecord = asRecord(payload);
  const usage = asRecord(payloadRecord.usage ?? payloadRecord['usage'] ?? payloadRecord.token_usage ?? payloadRecord['token-usage']);

  const fiveHourRaw =
    usage.five_hour_limit
    ?? usage.fiveHourLimit
    ?? usage['5h_limit']
    ?? payloadRecord.five_hour_limit
    ?? payloadRecord.fiveHourLimit
    ?? payloadRecord['5h_limit'];
  const weeklyRaw =
    usage.weekly_limit
    ?? usage.weeklyLimit
    ?? payloadRecord.weekly_limit
    ?? payloadRecord.weeklyLimit;

  const fiveHourLimitPct = extractLimitPct(fiveHourRaw);
  const weeklyLimitPct = extractLimitPct(weeklyRaw);

  if (fiveHourLimitPct === null && weeklyLimitPct === null) return null;
  return { fiveHourLimitPct, weeklyLimitPct };
}

export function normalizeInputMessages(payload: unknown): string[] {
  const payloadRecord = asRecord(payload);
  const items = payloadRecord['input-messages'] || payloadRecord.input_messages || [];
  if (!Array.isArray(items)) return [];
  return items.map((item) => safeString(item));
}

export function renderPrompt(template: unknown, context: PromptContext): string {
  return safeString(template)
    .replaceAll('{{mode}}', context.mode)
    .replaceAll('{{thread_id}}', context.threadId)
    .replaceAll('{{turn_id}}', context.turnId)
    .replaceAll('{{timestamp}}', context.timestamp);
}

export function hasNonLatinScript(text: unknown): boolean {
  const source = safeString(text);
  if (!source) return false;
  for (const char of source) {
    if (!/\p{Letter}/u.test(char)) continue;
    if (/\p{Script=Latin}/u.test(char)) continue;
    return true;
  }
  return false;
}

export function injectLanguageReminder(prompt: unknown, sourceText: unknown): string {
  const basePrompt = safeString(prompt);
  if (!hasNonLatinScript(sourceText)) return basePrompt;
  if (basePrompt.includes(LANGUAGE_REMINDER_MARKER)) return basePrompt;
  return `${basePrompt}\n${LANGUAGE_REMINDER_TEXT}`;
}
