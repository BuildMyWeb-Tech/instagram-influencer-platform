import "dotenv/config";
import express from "express";
import path from "path";
import routes from "./api/routes";
import { closeBrowser } from "./scraper/instagramScraper";
import prisma from "./db/prismaClient";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── API routes (BEFORE static, so /api/* never falls through) ────────────────
app.use("/api", routes);

// ─── Static dashboard ─────────────────────────────────────────────────────────
// ts-node-dev: __dirname = <project>/src  → public is at <project>/public
// compiled:    __dirname = <project>/dist → public is at <project>/public
// Both resolve correctly with this logic:
const publicDir = path.resolve(__dirname, "..", "public");
console.log(`[Server] Serving static from: ${publicDir}`);
app.use(express.static(publicDir));

// ─── Catch-all: serve dashboard for any non-API route ────────────────────────
app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function main() {
  try {
    await prisma.$connect();
    console.log("[Server] ✅ Database connected");
  } catch (err) {
    console.error("[Server] ❌ Database connection failed:", err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`\n✅ Server running  →  http://localhost:${PORT}`);
    console.log(`📊 Dashboard       →  http://localhost:${PORT}/`);
    console.log(`🔌 API health      →  http://localhost:${PORT}/api/health\n`);
  });
}

process.on("SIGTERM", async () => { await closeBrowser(); await prisma.$disconnect(); process.exit(0); });
process.on("SIGINT",  async () => { await closeBrowser(); await prisma.$disconnect(); process.exit(0); });

main().catch((err) => { console.error("[Server] Fatal:", err); process.exit(1); });
