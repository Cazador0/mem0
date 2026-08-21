// Test env: in-memory DB, no fallback beta path, no embeddings endpoint.
process.env.ENGRAM_DB = ":memory:";
process.env.ENGRAM_FALLBACKS = "off";
process.env.ENGRAM_EMBEDDINGS_URL = "";
