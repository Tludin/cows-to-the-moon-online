// In-memory metrics registry — zero dependencies, observation only.
//
// Layering: this module depends on nothing (like ws.ts) and nothing about it
// touches game rules. Callers add one-line `inc()` calls at existing decision
// points; `gauge()` registers a callback so point-in-time values (room count,
// connected players) are always read fresh at scrape time.
//
// Counters only ever go up and reset on process restart — dashboards graph
// their rate of change, so that's fine. The registry is a module-level
// singleton: every importer shares the same counters (Node ES modules are
// instantiated once per process).

const counters = new Map<string, number>();
const gauges = new Map<string, () => number>();

/** Increments a counter, creating it at 0 on first use. */
export function inc(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

/** Reads one counter (0 if it never fired) — used by tests and snapshot(). */
export function counterValue(name: string): number {
  return counters.get(name) ?? 0;
}

/**
 * Registers a gauge as a callback, evaluated fresh on every snapshot.
 * Re-registering a name replaces the callback (the newest RoomManager wins —
 * only relevant in tests; production has exactly one).
 */
export function gauge(name: string, fn: () => number): void {
  gauges.set(name, fn);
}

/** All counters plus freshly-evaluated gauges as one plain object. */
export function snapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of counters) out[k] = v;
  for (const [k, fn] of gauges) out[k] = fn();
  return out;
}

/**
 * Prometheus text exposition format (v0.0.4) — scrapeable as-is by
 * Prometheus or the CloudWatch agent. Counters are typed `counter` (by the
 * `_total` naming convention), everything else `gauge`.
 */
export function toPrometheus(): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(snapshot())) {
    const type = name.endsWith('_total') ? 'counter' : 'gauge';
    lines.push(`# TYPE ${name} ${type}`, `${name} ${value}`);
  }
  return lines.join('\n') + '\n';
}
