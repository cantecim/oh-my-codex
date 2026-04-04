/**
 * Pure utility helpers shared across notify-hook modules.
 * No I/O, no side effects.
 */

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function safeString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return String(value);
}

export function clampPct(value: unknown): number | null {
  const normalizedValue = Number(value);
  if (!Number.isFinite(normalizedValue)) return null;
  if (normalizedValue < 0) return 0;
  if (normalizedValue <= 1) return Math.round(normalizedValue * 100);
  if (normalizedValue > 100) return 100;
  return Math.round(normalizedValue);
}

export function isTerminalPhase(phase: unknown): boolean {
  return phase === 'complete' || phase === 'failed' || phase === 'cancelled';
}
