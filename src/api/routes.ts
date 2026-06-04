/**
 * routes.ts — Express API routes
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
  syncInfluencer,
  getInfluencerWithPosts,
  getSyncHistory,
} from "../services/syncService";
import prisma from "../db/prismaClient";

const router = Router();

const SyncSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(60)
    .transform((v) => {
      // Accept full URLs like https://www.instagram.com/nike/ or instagram.com/nike
      const match = v.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
      if (match) return match[1];
      // Strip @ prefix
      return v.replace(/^@/, "").trim();
    })
    .refine((v) => /^[a-zA-Z0-9._]{1,30}$/.test(v), "Invalid Instagram username"),
});

// POST /api/sync
router.post("/sync", async (req: Request, res: Response) => {
  const parsed = SyncSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid input",
      details: parsed.error.errors.map((e) => e.message).join(", "),
    });
  }

  const { username } = parsed.data;

  try {
    console.log(`[API] POST /api/sync — @${username}`);
    const result = await syncInfluencer({ username });

    const httpStatus =
      result.status === "failed" ? 500 :
      result.status === "partial" ? 207 : 200;

    return res.status(httpStatus).json(result);
  } catch (err: any) {
    return res.status(500).json({
      error: "Internal server error",
      message: err.message ?? "Unknown error",
    });
  }
});

// GET /api/profile/:username
router.get("/profile/:username", async (req: Request, res: Response) => {
  const { username } = req.params;
  try {
    const influencer = await getInfluencerWithPosts(username);
    if (!influencer) {
      return res.status(404).json({ error: "Not found. Run POST /api/sync first." });
    }
    return res.json(influencer);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/profile/:username/posts
router.get("/profile/:username/posts", async (req: Request, res: Response) => {
  const { username } = req.params;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const offset = Number(req.query.offset) || 0;
  try {
    const influencer = await prisma.influencer.findUnique({ where: { username }, select: { id: true } });
    if (!influencer) return res.status(404).json({ error: "Not found" });

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where: { influencerId: influencer.id },
        orderBy: { publishedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.post.count({ where: { influencerId: influencer.id } }),
    ]);

    return res.json({ total, limit, offset, posts });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/profile/:username/history
router.get("/profile/:username/history", async (req: Request, res: Response) => {
  const { username } = req.params;
  try {
    const history = await getSyncHistory(username, 20);
    return res.json(history);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/influencers
router.get("/influencers", async (_req: Request, res: Response) => {
  try {
    const influencers = await prisma.influencer.findMany({
      orderBy: { lastSyncedAt: "desc" },
      include: {
        _count: { select: { posts: true } },
        posts: {
          orderBy: { publishedAt: "desc" },
          take: 3,
          select: { thumbnailUrl: true, mediaUrl: true, mediaType: true, likesCount: true },
        },
      },
    });
    return res.json(influencers);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/health
router.get("/health", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.json({ status: "ok", db: "connected", ts: new Date().toISOString() });
  } catch {
    return res.status(503).json({ status: "degraded", db: "disconnected" });
  }
});

// GET /api/stats
router.get("/stats", async (_req: Request, res: Response) => {
  try {
    const [totalInfluencers, totalPosts, recentSyncs, successSyncs] = await Promise.all([
      prisma.influencer.count(),
      prisma.post.count(),
      prisma.syncLog.count(),
      prisma.syncLog.count({ where: { status: "success" } }),
    ]);
    return res.json({
      totalInfluencers,
      totalPosts,
      totalSyncs: recentSyncs,
      successRate: recentSyncs > 0 ? Math.round((successSyncs / recentSyncs) * 100) : 0,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
