// Structured JSON logging — zero dependencies, one JSON document per line.
//
// One-line-per-event JSON is what log aggregators (CloudWatch Logs Insights,
// journald pipelines, etc.) parse structured fields out of; free-text logs
// would need regex scraping. Like metrics.ts, this module depends on nothing
// so any layer (ws.ts included) may import it without creating cycles.
//
// Fields are caller-supplied; never log hidden game information (hand
// contents, deck order) — room codes, player ids, and event names only.

type Level = 'info' | 'warn' | 'error';

function write(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  // Single console.log call => each event is one complete, parseable line.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) => write('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write('error', event, fields),
};
