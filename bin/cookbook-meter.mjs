#!/usr/bin/env node
// Thin launcher: registers the tsx loader, then runs the TypeScript CLI.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
