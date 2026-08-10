import { stderr, stdout } from "node:process";

export type Logger = {
  readonly verbose: boolean;
  info(message?: string): void;
  verboseInfo(message?: string): void;
  error(message: string): void;
};

function writeLine(stream: typeof stdout | typeof stderr, message = ""): void {
  stream.write(`${message}\n`);
}

export function createLogger(verbose = false): Logger {
  return {
    verbose,
    info(message) {
      writeLine(stdout, message);
    },
    verboseInfo(message) {
      if (verbose) {
        writeLine(stdout, message);
      }
    },
    error(message) {
      writeLine(stderr, message);
    },
  };
}
