import type {SubsystemLogger} from "openclaw/plugin-sdk/runtime";

type LogMethod = (message: string, meta?: Record<string, unknown>) => void;
type LevelKey = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export function captureLogger(logger: SubsystemLogger): {messages: string[]; restore: () => void} {
  const messages: string[] = [];
  const levels: LevelKey[] = ["trace", "debug", "info", "warn", "error", "fatal"];
  const originals: Partial<Record<LevelKey, LogMethod>> = {};

  for (const level of levels) {
    originals[level] = logger[level];
    logger[level] = (msg: string, meta?: Record<string, unknown>) => {
      messages.push(meta ? `${msg} ${JSON.stringify(meta)}` : msg);
    };
  }

  return {
    messages,
    restore: () => {
      for (const level of levels) {
        const orig = originals[level];
        if (orig) logger[level] = orig;
      }
    },
  };
}
