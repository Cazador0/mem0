import { loadConfig } from "./config";
import { bootstrap } from "./bootstrap";
import { agentLoop } from "./agent/loop";
import { startScheduler } from "./orchestration/scheduler";
import { createServer } from "./server/routes";

const config = loadConfig();
const deps = bootstrap(config);
startScheduler(deps, id => agentLoop(id, deps));
const server = createServer(deps);

console.log(
  `[engram] listening on http://localhost:${server.port} — model ${config.model}, db ${config.dbPath}` +
    (config.embeddingsUrl ? "" : " (degraded archival search: FTS + entities only)"),
);
console.log(`[engram] constitution v${deps.constitution.version} loaded (digest ${deps.constitution.digest})`);
