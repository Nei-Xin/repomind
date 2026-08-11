#!/usr/bin/env node
import { VERSION } from "../version.js";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
  console.log(VERSION);
} else {
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
    console.error(warning.stack ?? `${warning.name}: ${warning.message}`);
  });
  await import("./index.js");
}
