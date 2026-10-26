// Run by the desktop app (OWLBOT_DESKTOP=1): a `stop` line on stdin, or the app closing the pipe, stops the daemon.
// Windows has no SIGTERM for a windowless child.

import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export function stopOnDesktopStdin(input: Readable, stop: () => void): void {
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    if (line.trim() === "stop") stop();
  });
  lines.on("close", stop);
}
