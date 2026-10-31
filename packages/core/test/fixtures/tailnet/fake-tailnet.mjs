#!/usr/bin/env node
// A stand-in for piomio-tailnet in tests: it keeps the start line in <dir>/start.json and replays the states the test
// put in <dir>/fake.json ({ states: [...], crashOnce?: true }), one every 20 ms. {"type":"logout"} leaves
// <dir>.logged-out next to the dir (which the hub then deletes) and exits; closing stdin exits.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

let dir;
createInterface({ input: process.stdin })
  .on("line", (line) => {
    const msg = JSON.parse(line);
    if (!dir) {
      dir = msg.dir;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "start.json"), line);
      const plan = existsSync(join(dir, "fake.json")) ? JSON.parse(readFileSync(join(dir, "fake.json"), "utf8")) : { states: [] };
      let i = 0;
      const next = () => {
        if (i < plan.states.length) {
          process.stdout.write(JSON.stringify({ type: "state", ...plan.states[i++] }) + "\n");
          setTimeout(next, 20);
        } else if (plan.crashOnce && !existsSync(join(dir, "crashed"))) {
          writeFileSync(join(dir, "crashed"), "");
          process.stderr.write("boom: the fake node fell over\n");
          process.exit(3);
        }
      };
      next();
    } else if (msg.type === "logout") {
      writeFileSync(`${dir}.logged-out`, "");
      process.exit(0);
    }
  })
  .on("close", () => process.exit(0));
