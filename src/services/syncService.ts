/**
 * syncService.ts
 *
 * Orchestrates the full scrape → parse → store pipeline.
 * Handles partial saves: even if some data is missing, save what we have.
 */

import prisma from "../db/prismaClient";
import { scrapeInstagramProfile } from "../scraper/instagramScraper";
import { ParsedProfile } from "../scraper/profileParser";
import { ParsedPost } from "../scraper/postParser";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncInput {
  username: string;
}

export interface SyncResult {
  username: string;
  postsCollected: number;
  newPosts: number;
  updatedPosts: number;
  profile: {
    id: string;
    followers: number | null;
    displayName: string | null;
    totalPosts: number | null;
  } | null;
  errors: string[];
  durationMs: number;
  status: "success" | "partial" | "failed";
}

// ─── Main sync function ───────────────────────────────────────────────────────

export async function syncInfluencer(input: SyncInput): Promise<SyncResult> {
  const { username } = input;
  const startTime = Date.now();
  const errors: string[] = [];

  console.log(`[SyncService] Starting sync for @${username}`);

  // ── 1. Scrape ─────────────────────────────────────────────────────────────
  let scrapeResult;
  try {
    scrapeResult = await scrapeInstagramProfile(username);
    errors.push(...scrapeResult.errors);
  } catch (err: any) {
    const msg = `Scraper threw an uncaught error: ${err.message ?? String(err)}`;
    errors.push(msg);
    console.error("[SyncService]", msg);

    const durationMs = Date.now() - startTime;
    await logSync(username, "failed", 0, 0, msg, durationMs);
    return {
      username,
      postsCollected: 0,
      newPosts: 0,
      updatedPosts: 0,
      profile: null,
      errors,
      durationMs,
      status: "failed",
    };
  }

  const { profile, posts } = scrapeResult;

  // ── 2. Upsert Influencer ──────────────────────────────────────────────────
  let influencer = null;
  try {
    influencer = await upsertInfluencer(username, profile);
    console.log(`[SyncService] Influencer upserted: ${influencer.id}`);
  } catch (err: any) {
    const msg = `DB error upserting influencer: ${err.message}`;
    errors.push(msg);
    console.error("[SyncService]", msg);

    const durationMs = Date.now() - startTime;
    await logSync(username, "failed", posts.length, 0, msg, durationMs);
    return {
      username,
      postsCollected: posts.length,
      newPosts: 0,
      updatedPosts: 0,
      profile: null,
      errors,
      durationMs,
      status: "failed",
    };
  }

  // ── 3. Upsert Posts ───────────────────────────────────────────────────────
  let newPosts = 0;
  let updatedPosts = 0;

  for (const post of posts) {
    try {
      const result = await upsertPost(influencer.id, post);
      if (result.isNew) newPosts++;
      else updatedPosts++;
    } catch (err: any) {
      const msg = `Failed to upsert post ${post.shortCode}: ${err.message}`;
      errors.push(msg);
      console.warn("[SyncService]", msg);
      // Continue with remaining posts — partial save is better than none
    }
  }

  // ── 4. Update lastSyncedAt ─────────────────────────────────────────────────
  try {
    await prisma.influencer.update({
      where: { id: influencer.id },
      data: { lastSyncedAt: new Date() },
    });
  } catch (err: any) {
    errors.push(`Failed to update lastSyncedAt: ${err.message}`);
  }

  // ── 5. Log and return ──────────────────────────────────────────────────────
  const durationMs = Date.now() - startTime;
  const hasAnyData = posts.length > 0 || profile !== null;
  const status: SyncResult["status"] =
    errors.length === 0 ? "success" : hasAnyData ? "partial" : "failed";

  await logSync(username, status, posts.length, newPosts, errors[0] ?? null, durationMs);

  console.log(
    `[SyncService] Sync complete for @${username}: ${posts.length} posts, ${newPosts} new, ${durationMs}ms`
  );

  return {
    username,
    postsCollected: posts.length,
    newPosts,
    updatedPosts,
    profile: influencer
      ? {
          id: influencer.id,
          followers: influencer.followerCount,
          displayName: influencer.displayName,
          totalPosts: influencer.totalPostCount,
        }
      : null,
    errors,
    durationMs,
    status,
  };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function upsertInfluencer(username: string, profile: ParsedProfile | null) {
  const data = {
    username,
    displayName: profile?.displayName ?? null,
    biography: profile?.biography ?? null,
    profileImageUrl: profile?.profileImageUrl ?? null,
    followerCount: profile?.followerCount ?? null,
    followingCount: profile?.followingCount ?? null,
    totalPostCount: profile?.totalPostCount ?? null,
    isVerified: profile?.isVerified ?? false,
    externalId: profile?.externalId ?? null,
  };

  return prisma.influencer.upsert({
    where: { username },
    create: data,
    update: {
      // Only overwrite non-null scraped values so we don't clobber known good data
      displayName: data.displayName ?? undefined,
      biography: data.biography ?? undefined,
      profileImageUrl: data.profileImageUrl ?? undefined,
      followerCount: data.followerCount ?? undefined,
      followingCount: data.followingCount ?? undefined,
      totalPostCount: data.totalPostCount ?? undefined,
      isVerified: data.isVerified,
      externalId: data.externalId ?? undefined,
    },
  });
}

async function upsertPost(
  influencerId: string,
  post: ParsedPost
): Promise<{ isNew: boolean }> {
  const existing = await prisma.post.findUnique({
    where: { postUrl: post.postUrl },
    select: { id: true },
  });

  const data = {
    influencerId,
    postUrl: post.postUrl,
    shortCode: post.shortCode,
    caption: post.caption,
    mediaType: post.mediaType,
    mediaUrl: post.mediaUrl,
    thumbnailUrl: post.thumbnailUrl,
    likesCount: post.likesCount,
    commentsCount: post.commentsCount,
    viewsCount: post.viewsCount,
    publishedAt: post.publishedAt,
  };

  if (existing) {
    await prisma.post.update({
      where: { id: existing.id },
      data: {
        likesCount: data.likesCount ?? undefined,
        commentsCount: data.commentsCount ?? undefined,
        viewsCount: data.viewsCount ?? undefined,
        caption: data.caption ?? undefined,
        mediaUrl: data.mediaUrl ?? undefined,
        thumbnailUrl: data.thumbnailUrl ?? undefined,
      },
    });
    return { isNew: false };
  }

  await prisma.post.create({ data });
  return { isNew: true };
}

async function logSync(
  username: string,
  status: string,
  postsCollected: number,
  newPosts: number,
  errorMessage: string | null,
  durationMs: number
): Promise<void> {
  try {
    await prisma.syncLog.create({
      data: {
        username,
        status,
        postsCollected,
        newPosts,
        errorMessage,
        durationMs,
      },
    });
  } catch (err) {
    console.warn("[SyncService] Failed to write sync log:", err);
  }
}

// ─── Query helpers ─────────────────────────────────────────────────────────────

export async function getInfluencerWithPosts(username: string) {
  return prisma.influencer.findUnique({
    where: { username },
    include: {
      posts: {
        orderBy: { publishedAt: "desc" },
        take: 100,
      },
    },
  });
}

export async function getSyncHistory(username: string, limit = 10) {
  return prisma.syncLog.findMany({
    where: { username },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
