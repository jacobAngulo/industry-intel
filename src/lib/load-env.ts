// Side-effect module for processes that Next.js does not start (the worker,
// scripts). Import it FIRST, before each module that reads process.env.
// The web process does not need it: Next.js loads `.env` itself.
//
// A variable that is already in the environment keeps its value.
// This module prints no value.
import fs from "node:fs";
import path from "node:path";

const envFile = path.resolve(process.cwd(), ".env");

if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
