import { env, stderr, stdout } from "node:process";

type LogLevel = "info" | "success" | "warn" | "error";

export type Logger = {
  readonly verbose: boolean;
  plain(message?: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  verboseInfo(message?: string): void;
  error(message: string): void;
};

const colors = {
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
} as const;

const labels: Record<LogLevel, string> = {
  info: "info",
  success: "done",
  warn: "warn",
  error: "error",
};

const labelColors: Record<LogLevel, keyof typeof colors> = {
  info: "cyan",
  success: "green",
  warn: "yellow",
  error: "red",
};

function colorsEnabled(): boolean {
  return env.FORCE_COLOR !== undefined || env.NO_COLOR === undefined;
}

function colorize(color: keyof typeof colors, text: string): string {
  if (!colorsEnabled()) {
    return text;
  }

  return `${colors[color]}${text}${colors.reset}`;
}

function format(level: LogLevel, message: string): string {
  const label = colorize(labelColors[level], labels[level].padEnd(5));
  return `${label} ${message}`;
}

function writeLine(stream: typeof stdout | typeof stderr, message = ""): void {
  stream.write(`${message}\n`);
}

export function createLogger(verbose = false): Logger {
  return {
    verbose,
    plain(message) {
      writeLine(stdout, message);
    },
    info(message) {
      writeLine(stdout, format("info", message));
    },
    success(message) {
      writeLine(stdout, format("success", message));
    },
    warn(message) {
      writeLine(stdout, format("warn", message));
    },
    verboseInfo(message) {
      if (verbose) {
        writeLine(stdout, message === undefined ? message : colorize("dim", message));
      }
    },
    error(message) {
      writeLine(stderr, format("error", message));
    },
  };
}
