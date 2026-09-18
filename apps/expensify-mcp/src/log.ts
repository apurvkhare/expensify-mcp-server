/**
 * One JSON line per event. The MCP Logging feature is deprecated in 2026-07-28,
 * so the server never sends notifications/message. Instead:
 *   stdio  -> stderr   (stdout is the protocol channel; one console.log breaks it)
 *   Worker -> console  (Workers Logs indexes JSON fields; wrangler tail shows them live)
 */
export type LogEvent = Record<string, unknown>;
export type Logger = (event: LogEvent) => void;

export function createLogger(sink: (line: string) => void, base: LogEvent = {}): Logger {
  return (event) => {
    sink(JSON.stringify({ ts: new Date().toISOString(), ...base, ...event }));
  };
}

export const stderrLogger = (base: LogEvent = {}) =>
  createLogger((line) => {
    process.stderr.write(line + '\n');
  }, base);

export const consoleLogger = (base: LogEvent = {}) =>
  createLogger((line) => {
    console.log(line);
  }, base);
