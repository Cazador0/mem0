import { loadConfig } from "./config";
import { closeDb } from "./db/database";
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

// Checkpoint the WAL on a normal shutdown so -wal/-shm sidecars do not outlive
// the process (they otherwise persist wherever Bun uses a dlopen'd SQLite).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[engram] ${signal} — checkpointing and closing the database`);
    void server.stop(true).finally(() => {
      closeDb(deps.db);
      process.exit(0);
    });
  });
}
