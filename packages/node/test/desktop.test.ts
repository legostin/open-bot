// The desktop app stops the machine daemon through its stdin.
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { stopOnDesktopStdin } from "../src/desktop.ts";

describe("desktop stdin", () => {
  it("stops on a stop line and when the pipe closes", async () => {
    const input = new PassThrough();
    const stop = vi.fn();
    stopOnDesktopStdin(input, stop);
    input.write("hello\nstop\n");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    input.end();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
  });
});
