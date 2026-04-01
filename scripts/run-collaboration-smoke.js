#!/usr/bin/env node
import { join } from 'node:path';

import { runCollaborationSmoke } from './collaboration-smoke.js';

const logDir = process.argv[2] || join(process.cwd(), '.tmp', `collaboration-smoke-${Date.now()}`);
const summary = await runCollaborationSmoke({
  repoRoot: process.cwd(),
  logDir
});

console.log(JSON.stringify(summary, null, 2));
