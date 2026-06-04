/**
 * debugScraper.ts
 * Dumps raw captured API responses so we can see exactly what Instagram returns.
 * Usage: npx ts-node src/scraper/debugScraper.ts nike
 */

import "dotenv/config";
import { chromium } from "playwright";
import * as fs from "fs";

const username = process.argv[2] ?? "natgeo";

async function main() {
  console.log(`\nDebugging Instagram responses for @${username}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
  });

  const captured: any[] = [];

  context.on("response", async (response) => {
    const url = response.url();
    if (
      url.includes("web_profile_info") ||
      url.includes("/api/v1/feed/user/") ||
      url.includes("graphql/query")
    ) {
      try {
        const body = await response.json().catch(() => null);
        if (body) {
          captured.push({ url: url.substring(0, 120), status: response.status(), body });
          console.log(`\n✅ CAPTURED [${response.status()}]: ${url.substring(0, 100)}`);
        }
      } catch {}
    }
  });

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  console.log(`Loading https://www.instagram.com/${username}/`);
  await page.goto(`https://www.instagram.com/${username}/`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  await new Promise(r => setTimeout(r, 5000));

  // Save dump
  const outFile = `debug_${username}_${Date.now()}.json`;
  fs.writeFileSync(outFile, JSON.stringify(captured, null, 2));
  console.log(`\n📁 Saved ${captured.length} responses to: ${outFile}`);

  // Print top-level keys of each response
  for (const r of captured) {
    console.log(`\n--- ${r.url} ---`);
    console.log("Top-level keys:", Object.keys(r.body));
    
    if (r.body?.data) {
      console.log("  data keys:", Object.keys(r.body.data));
      if (r.body.data?.user) {
        console.log("  data.user keys:", Object.keys(r.body.data.user));
        const u = r.body.data.user;
        console.log("  username:", u.username);
        console.log("  full_name:", u.full_name);
        console.log("  follower_count:", u.follower_count);
        console.log("  following_count:", u.following_count);
        console.log("  media_count:", u.media_count);
        console.log("  edge_followed_by:", u.edge_followed_by);
        console.log("  edge_owner_to_timeline_media count:", u.edge_owner_to_timeline_media?.count);
        console.log("  edge_owner_to_timeline_media edges count:", u.edge_owner_to_timeline_media?.edges?.length);
      }
    }
  }

  await browser.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
