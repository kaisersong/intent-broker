import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createBrokerService } from './broker/service.js';
import { createServer } from './http/server.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT || '4318');
const dbPath = resolve(process.env.INTENT_BROKER_DB || './.tmp/intent-broker.db');

mkdirSync(dirname(dbPath), { recursive: true });

const broker = createBrokerService({ dbPath });
const server = createServer({ broker });

await server.listen(port, host);

console.log(`intent-broker listening on http://${host}:${server.address().port}`);
console.log(`intent-broker db: ${dbPath}`);
