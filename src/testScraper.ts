/**
 * testScraper.ts  — v3
 * Standalone test — no DB needed.
 *
 * Usage:
 *   npx ts-node src/testScraper.ts nike
 *   npx ts-node src/testScraper.ts cristiano
 *   MAX_POSTS_PER_SYNC=100 npx ts-node src/testScraper.ts natgeo
 */

import "dotenv/config";
import { scrapeInstagramProfile, closeBrowser } from "./scraper/instagramScraper";

async function main() {
  const username = process.argv[2] ?? "natgeo";
  const maxPosts  = Number(process.env.MAX_POSTS_PER_SYNC ?? 100);

  console.log("\n╔══════════════════════════════════════════╗");
  console.log(`║  Instagram Scraper  →  @${username.padEnd(17)}║`);
  console.log(`║  Target posts: ${String(maxPosts).padEnd(26)}║`);
  console.log("╚══════════════════════════════════════════╝\n");

  const start = Date.now();

  let result;
  try {
    result = await scrapeInstagramProfile(username);
  } catch (err: any) {
    console.error("Fatal scraper error:", err.message);
    await closeBrowser();
    process.exit(1);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log("\n══════════════════════════════════════════════");
  console.log("  RESULT");
  console.log("══════════════════════════════════════════════");

  if (result.profile) {
    const p = result.profile;
    const fmt = (n: number | null) =>
      n !== null ? new Intl.NumberFormat("en-US").format(n) : "N/A";

    console.log(`\n  ✅ Profile @${p.username || "(parse error)"}`);
    console.log(`     Display name : ${p.displayName ?? "N/A"}`);
    console.log(`     Bio          : ${p.biography ? p.biography.slice(0, 70) + (p.biography.length > 70 ? "…" : "") : "N/A"}`);
    console.log(`     Followers    : ${fmt(p.followerCount)}`);
    console.log(`     Following    : ${fmt(p.followingCount)}`);
    console.log(`     Total posts  : ${fmt(p.totalPostCount)}`);
    console.log(`     Verified     : ${p.isVerified ? "✓ Yes" : "✗ No"}`);
    console.log(`     User ID      : ${p.externalId ?? "N/A"}`);
  } else {
    console.log("  ❌ Profile: not extracted");
  }

  console.log(`\n  📸 Posts collected : ${result.posts.length} / ${maxPosts} requested`);

  // Breakdown by media type
  const types = result.posts.reduce<Record<string, number>>((acc, p) => {
    acc[p.mediaType] = (acc[p.mediaType] ?? 0) + 1;
    return acc;
  }, {});
  if (Object.keys(types).length > 0) {
    const breakdown = Object.entries(types)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    console.log(`     Breakdown      : ${breakdown}`);
  }

  // Engagement stats
  const withLikes    = result.posts.filter(p => p.likesCount !== null).length;
  const withComments = result.posts.filter(p => p.commentsCount !== null).length;
  const withCaptions = result.posts.filter(p => p.caption).length;
  const withDates    = result.posts.filter(p => p.publishedAt !== null).length;
  console.log(`     With likes     : ${withLikes}/${result.posts.length}`);
  console.log(`     With comments  : ${withComments}/${result.posts.length}`);
  console.log(`     With captions  : ${withCaptions}/${result.posts.length}`);
  console.log(`     With dates     : ${withDates}/${result.posts.length}`);

  // Sample posts
  if (result.posts.length > 0) {
    console.log("\n  Sample posts:");
    for (const post of result.posts.slice(0, 5)) {
      const fmt = (n: number | null) =>
        n !== null ? new Intl.NumberFormat("en-US").format(n) : "N/A";
      console.log(`\n    🔗 ${post.postUrl}`);
      console.log(`       Type     : ${post.mediaType}`);
      console.log(`       Likes    : ${fmt(post.likesCount)}`);
      console.log(`       Comments : ${fmt(post.commentsCount)}`);
      console.log(`       Date     : ${post.publishedAt?.toISOString().slice(0, 10) ?? "N/A"}`);
      if (post.caption) {
        const cap = post.caption.replace(/\n/g, " ").slice(0, 90);
        console.log(`       Caption  : ${cap}${post.caption.length > 90 ? "…" : ""}`);
      }
    }
    if (result.posts.length > 5) {
      console.log(`\n    … and ${result.posts.length - 5} more posts`);
    }
  }

  if (result.errors.length > 0) {
    console.log("\n  ⚠  Warnings:");
    result.errors.forEach(e => console.log(`     - ${e}`));
  }

  // Final verdict
  const target100 = result.posts.length >= 100;
  const target50  = result.posts.length >= 50;
  const verdict   = target100 ? "✅ 100-post target MET"
                  : target50  ? "⚠  50-post partial result"
                  : "❌ Below 50 posts — pagination blocked";

  console.log(`\n  ${verdict}`);
  console.log(`  Total time: ${elapsed}s`);
  console.log("══════════════════════════════════════════════\n");

  await closeBrowser();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await closeBrowser();
  process.exit(1);
});
