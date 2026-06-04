/**
 * instagramScraper.ts  — v3 (pagination fix)
 *
 * Extraction pipeline:
 *   1. Load profile page — captures web_profile_info XHR (profile + first 12 posts)
 *   2. Cursor pagination loop — fetches remaining posts via graphql/query
 *      Tries 4 known query hashes + variables format fallbacks
 *   3. /api/v1/feed/user/ endpoint fallback
 *   4. Script-tag JSON extraction (profile fallback)
 *   5. DOM scraping (profile last resort)
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import {
  parseProfileFromApiResponse,
  ParsedProfile,
} from "./profileParser";
import {
  extractPostsFromAnyResponse,
  parsePostsFromEdges,
  parsePostsFromFeedItems,
  ParsedPost,
} from "./postParser";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScrapeResult {
  profile: ParsedProfile | null;
  posts: ParsedPost[];
  errors: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

// Known working query hashes for user timeline media (Instagram rotates these)
// Listed newest-first — first success wins. Instagram rotates these ~quarterly.
const TIMELINE_QUERY_HASHES = [
  "e769aa130647d2354c40ea6a439bfc08",
  "58b6785bea111c67129decbe6a448951",
  "003056d32c2554def87228bc3fd9668a",
  "42323d64886122307be10013ad2dcc44",
  "69cba40317214fc3bbf3b3b2b4e80539",
  "472f257a40c653c64c666ce877d59d2b",
];

// doc_id based queries (newer format Instagram uses internally)
const TIMELINE_DOC_IDS = [
  "17888483320059182",
  "17858893269000001",
];

const COOKIES_PATH = process.env.COOKIES_PATH ?? "./cookies.json";
const HEADLESS     = process.env.HEADLESS !== "false";
const MAX_POSTS    = Number(process.env.MAX_POSTS_PER_SYNC ?? 100);
const PAGE_SIZE    = 12; // Instagram's default page size

// ─── Browser singleton ────────────────────────────────────────────────────────

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

async function loadCookies(context: BrowserContext): Promise<void> {
  try {
    if (!fs.existsSync(COOKIES_PATH)) return;
    const raw = fs.readFileSync(COOKIES_PATH, "utf-8").trim();
    if (!raw) return;
    const cookies = JSON.parse(raw);
    if (Array.isArray(cookies) && cookies.length > 0) {
      await context.addCookies(cookies);
      console.log(`[Scraper] Loaded ${cookies.length} cookies`);
    }
  } catch (err) {
    console.warn("[Scraper] Cookie load skipped:", (err as Error).message);
    // Delete corrupted cookie file so next run starts fresh
    try { fs.unlinkSync(COOKIES_PATH); } catch {}
  }
}

async function saveCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log(`[Scraper] Saved ${cookies.length} cookies`);
  } catch (err) {
    console.warn("[Scraper] Cookie save skipped:", (err as Error).message);
  }
}

// ─── Optional login ───────────────────────────────────────────────────────────

async function attemptLogin(page: Page): Promise<boolean> {
  const igUser = process.env.IG_USERNAME;
  const igPass = process.env.IG_PASSWORD;
  if (!igUser || !igPass) return false;

  try {
    console.log("[Scraper] Attempting login...");
    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await randomDelay(1500, 2500);

    const usernameInput = page.locator('input[name="username"]');
    if (!(await usernameInput.isVisible({ timeout: 3000 }).catch(() => false))) {
      console.log("[Scraper] Already logged in");
      return true;
    }

    await usernameInput.fill(igUser);
    await randomDelay(400, 800);
    await page.locator('input[name="password"]').fill(igPass);
    await randomDelay(400, 800);
    await page.keyboard.press("Enter");
    await page.waitForNavigation({ waitUntil: "networkidle", timeout: 20_000 });
    await randomDelay(2000, 3000);

    for (const text of ["Not Now", "Not now", "Skip"]) {
      const btn = page.locator(`text="${text}"`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await randomDelay(800, 1500);
      }
    }
    console.log("[Scraper] Login done");
    return true;
  } catch (err) {
    console.warn("[Scraper] Login failed:", (err as Error).message);
    return false;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function randomDelay(min = 1000, max = 3000): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
}

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function isBlockedPage(html: string): boolean {
  if (html.includes("Sorry, this page") && html.includes("Page Not Found")) return true;
  if (html.includes('"errorCode":"challenge"')) return true;
  if (html.length < 5000 && html.includes('"challenge_type"')) return true;
  return false;
}

// ─── Cursor-based pagination ──────────────────────────────────────────────────
//
// Instagram returns 12 posts per page. To get more, we use the end_cursor
// from page_info and call graphql/query with after=cursor in a loop.
//
// We try multiple query hashes because Instagram rotates them.
// For each page we try hashes one by one until one returns 200.

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

async function fetchPostsPage(
  page: Page,
  userId: string,
  cursor: string | null,
  pageSize: number
): Promise<{ posts: ParsedPost[]; pageInfo: PageInfo } | null> {
  const variables = JSON.stringify({
    id: userId,
    first: pageSize,
    after: cursor ?? undefined,
  });

  // Build all URLs to try: query_hash style + doc_id style
  const urlsToTry: string[] = [
    ...TIMELINE_QUERY_HASHES.map(h =>
      `https://www.instagram.com/graphql/query/?query_hash=${h}&variables=${encodeURIComponent(variables)}`
    ),
    ...TIMELINE_DOC_IDS.map(d =>
      `https://www.instagram.com/graphql/query/?doc_id=${d}&variables=${encodeURIComponent(variables)}`
    ),
  ];

  for (const url of urlsToTry) {
    const hashOrId = url.includes("query_hash=") 
      ? url.match(/query_hash=([^&]+)/)?.[1]?.substring(0,8) 
      : url.match(/doc_id=([^&]+)/)?.[1];

    const result = await page.evaluate(async (fetchUrl: string) => {
      try {
        const r = await fetch(fetchUrl, {
          method: "GET",
          credentials: "include",
          headers: {
            "X-IG-App-ID": "936619743392459",
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json",
          },
        });
        if (!r.ok) return { status: r.status, data: null };
        const data = await r.json().catch(() => null);
        return { status: r.status, data };
      } catch (e: any) {
        return { status: 0, data: null };
      }
    }, url);

    if (!result || result.status !== 200 || !result.data) {
      console.log(`[Pagination] ${hashOrId}... → ${result?.status ?? "error"}`);
      continue;
    }

    const media =
      result.data?.data?.user?.edge_owner_to_timeline_media ??
      result.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;

    if (!media) {
      console.log(`[Pagination] ${hashOrId}... → 200 but no media field`);
      continue;
    }

    const edges = media?.edges ?? [];
    const pi = media?.page_info ?? {};

    console.log(
      `[Pagination] ${hashOrId}... ✅ got ${edges.length} posts | hasNext=${pi.has_next_page}`
    );

    return {
      posts: parsePostsFromEdges(edges),
      pageInfo: {
        hasNextPage: pi.has_next_page ?? false,
        endCursor: pi.end_cursor ?? null,
      },
    };
  }

  return null; // All hashes failed
}

/**
 * Paginate using the /api/v1/feed/user/ endpoint as a fallback.
 * Uses max_id cursor (older API style).
 */
async function fetchPostsViaFeedApi(
  page: Page,
  userId: string,
  maxId: string | null,
  count: number
): Promise<{ posts: ParsedPost[]; nextMaxId: string | null } | null> {
  let url = `https://www.instagram.com/api/v1/feed/user/${userId}/?count=${count}`;
  if (maxId) url += `&max_id=${maxId}`;

  const result = await page.evaluate(async (fetchUrl: string) => {
    try {
      const r = await fetch(fetchUrl, {
        credentials: "include",
        headers: { "X-IG-App-ID": "936619743392459" },
      });
      if (!r.ok) return null;
      return await r.json().catch(() => null);
    } catch { return null; }
  }, url);

  if (!result) return null;

  const items = result?.items ?? [];
  const nextMaxId = result?.next_max_id ?? null;

  if (items.length === 0) return null;

  return {
    posts: parsePostsFromFeedItems(items),
    nextMaxId,
  };
}

// ─── Main scraper ─────────────────────────────────────────────────────────────

export async function scrapeInstagramProfile(username: string): Promise<ScrapeResult> {
  const browser = await getBrowser();
  const errors: string[] = [];
  let profile: ParsedProfile | null = null;
  const posts: ParsedPost[] = [];

  const context = await browser.newContext({
    userAgent: randomUA(),
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  const capturedResponses: Array<{ url: string; body: any }> = [];

  context.on("response", async (response) => {
    const url = response.url();
    if (response.status() !== 200) return;
    const relevant =
      url.includes("/api/v1/users/web_profile_info") ||
      url.includes("/api/v1/feed/user/") ||
      url.includes("graphql/query") ||
      url.includes("__a=1");
    if (!relevant) return;
    try {
      const body = await response.json().catch(() => null);
      if (body) {
        capturedResponses.push({ url, body });
        console.log(`[Scraper] ✅ Captured: ${url.substring(0, 90)}`);
      }
    } catch {}
  });

  try {
    await loadCookies(context);
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });

    if (process.env.IG_USERNAME && process.env.IG_PASSWORD) {
      const ok = await attemptLogin(page);
      if (ok) await saveCookies(context);
    }

    // ── Step 1: Load profile page (gets profile + first 12 posts via XHR) ─────
    console.log(`\n[Scraper] ── Step 1: Load profile page for @${username}`);
    let loadOk = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(`https://www.instagram.com/${username}/`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await randomDelay(3000, 5000);
        loadOk = true;
        break;
      } catch {
        console.warn(`[Scraper] Page load attempt ${attempt} failed`);
        if (attempt < 3) await randomDelay(3000, 5000);
      }
    }

    if (!loadOk) {
      errors.push("Failed to load Instagram profile page after 3 attempts");
      return { profile, posts, errors };
    }

    const pageContent = await page.content();
    if (isBlockedPage(pageContent)) {
      errors.push("Instagram served a challenge/blocked page");
      console.warn("[Scraper] ⚠ Challenge/block detected");
    }

    // ── Step 2: Extract profile + first batch of posts from XHR ───────────────
    console.log(`[Scraper] ── Step 2: Extract from ${capturedResponses.length} captured XHR responses`);
    for (const { url, body } of capturedResponses) {
      if (!profile?.username) {
        const parsed = parseProfileFromApiResponse(body);
        if (parsed?.username) {
          profile = parsed;
          console.log(`[Scraper] ✅ Profile: @${profile.username} | ${profile.followerCount?.toLocaleString("en-US")} followers`);
        }
      }
      const newPosts = extractPostsFromAnyResponse(body);
      if (newPosts.length > 0) {
        posts.push(...newPosts);
        console.log(`[Scraper] +${newPosts.length} posts (first page)`);
      }
    }

    // ── Step 3: Script-tag fallback for profile ───────────────────────────────
    if (!profile?.username) {
      profile = await extractProfileFromScripts(page);
      if (profile?.username) console.log(`[Scraper] ✅ Profile from script tags`);
    }

    // ── Step 4: DOM fallback for profile ──────────────────────────────────────
    if (!profile?.username) {
      profile = await extractProfileFromDOM(page, username);
      if (profile?.username) console.log(`[Scraper] ✅ Profile from DOM`);
    }

    if (!profile?.externalId) {
      errors.push("Could not extract user ID — pagination will be skipped");
    }

    // ── Step 5: Cursor-based pagination to reach MAX_POSTS ────────────────────
    const userId = profile?.externalId ?? null;

    if (userId && posts.length < MAX_POSTS) {
      console.log(`\n[Scraper] ── Step 3: Cursor pagination (have ${posts.length}, want ${MAX_POSTS})`);

      // Get the end_cursor from the first captured web_profile_info response
      let cursor: string | null = null;
      for (const { body } of capturedResponses) {
        const pi =
          body?.data?.user?.edge_owner_to_timeline_media?.page_info ??
          body?.graphql?.user?.edge_owner_to_timeline_media?.page_info;
        if (pi?.end_cursor) {
          cursor = pi.end_cursor;
          console.log(`[Pagination] Got initial cursor from XHR: ${cursor?.substring(0, 20)}...`);
          break;
        }
      }

      let paginationMethod: "graphql" | "feed_api" | "none" = "none";
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 2;
      let page_num = 1;

      // Try graphql cursor pagination first
      while (posts.length < MAX_POSTS && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
        page_num++;
        console.log(`[Pagination] Page ${page_num} (cursor: ${cursor?.substring(0, 15) ?? "start"}...)`);

        const result = await fetchPostsPage(page, userId, cursor, PAGE_SIZE);

        if (result && result.posts.length > 0) {
          posts.push(...result.posts);
          paginationMethod = "graphql";
          consecutiveFailures = 0;
          cursor = result.pageInfo.endCursor;
          console.log(`[Pagination] Page ${page_num}: +${result.posts.length} posts | total=${posts.length} | hasNext=${result.pageInfo.hasNextPage}`);

          if (!result.pageInfo.hasNextPage) {
            console.log("[Pagination] Reached end of timeline");
            break;
          }
          await randomDelay(1500, 3000); // polite delay between pages
        } else {
          consecutiveFailures++;
          console.warn(`[Pagination] Page ${page_num}: no results (attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
          if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
            await randomDelay(3000, 5000); // longer backoff on failure
          }
        }
      }

      // If graphql pagination failed, try /api/v1/feed/user/ fallback
      if (paginationMethod === "none" && posts.length < MAX_POSTS) {
        console.log(`\n[Scraper] ── GraphQL pagination failed, trying /api/v1/feed/user/ fallback`);
        let maxId: string | null = null;
        let feedPage = 0;
        let feedFailures = 0;

        while (posts.length < MAX_POSTS && feedPage < 10 && feedFailures < 2) {
          feedPage++;
          const feedResult = await fetchPostsViaFeedApi(page, userId, maxId, PAGE_SIZE);

          if (feedResult && feedResult.posts.length > 0) {
            posts.push(...feedResult.posts);
            paginationMethod = "feed_api";
            feedFailures = 0;
            maxId = feedResult.nextMaxId;
            console.log(`[FeedAPI] Page ${feedPage}: +${feedResult.posts.length} posts | total=${posts.length}`);
            if (!maxId) { console.log("[FeedAPI] No next_max_id — end of feed"); break; }
            await randomDelay(1500, 3000);
          } else {
            feedFailures++;
            console.warn(`[FeedAPI] Page ${feedPage}: failed`);
          }
        }
      }

      // ── Method 3: Scroll to trigger Instagram's own lazy-load XHR ──────────
      // Most reliable — lets Instagram's own JS fire the pagination requests,
      // we just intercept what comes back via context.on("response").
      if (paginationMethod === "none" && posts.length < MAX_POSTS) {
        console.log(`\n[Scraper] ── Method 3: Scroll-triggered XHR interception`);
        const prevCount = capturedResponses.length;
        let scrollRound = 0;
        const maxScrolls = 8;
        let noNewPostsRounds = 0;

        // Scroll to top of posts grid first
        await page.evaluate(() => window.scrollTo(0, 600));
        await randomDelay(1500, 2500);

        while (posts.length < MAX_POSTS && scrollRound < maxScrolls && noNewPostsRounds < 3) {
          const postsBefore = posts.length;
          scrollRound++;

          // Scroll down to trigger lazy load
          await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2.5));
          await randomDelay(2500, 4000); // wait for XHR to fire and complete

          // Process newly captured responses since last check
          const newResponses = capturedResponses.slice(prevCount + posts.length - postsBefore);
          for (const { body } of newResponses) {
            const scrollPosts = extractPostsFromAnyResponse(body);
            if (scrollPosts.length > 0) {
              posts.push(...scrollPosts);
              paginationMethod = "graphql";
            }
          }

          const gained = posts.length - postsBefore;
          if (gained > 0) {
            console.log(`[ScrollPagination] Scroll ${scrollRound}: +${gained} posts | total=${posts.length}`);
            noNewPostsRounds = 0;
          } else {
            noNewPostsRounds++;
            console.log(`[ScrollPagination] Scroll ${scrollRound}: no new posts (${noNewPostsRounds}/3)`);
          }
        }
      }

      if (paginationMethod === "none") {
        errors.push("Pagination limited — Instagram blocked additional page requests. First 12 posts saved successfully.");
        console.warn("[Scraper] ⚠ All pagination methods exhausted — returning first page only");
      } else {
        console.log(`[Scraper] ✅ Pagination complete via ${paginationMethod} — ${posts.length} total posts`);
      }
    }

    await saveCookies(context);

  } catch (err: any) {
    const msg = `Scraper error: ${err.message ?? String(err)}`;
    errors.push(msg);
    console.error("[Scraper]", msg);
  } finally {
    await context.close();
  }

  // Deduplicate by shortCode
  const seen = new Set<string>();
  const unique = posts.filter((p) => {
    if (!p.shortCode || seen.has(p.shortCode)) return false;
    seen.add(p.shortCode);
    return true;
  });

  console.log(`\n[Scraper] ═══ DONE: @${profile?.username ?? username} | posts=${unique.length} | errors=${errors.length}`);
  return { profile, posts: unique.slice(0, MAX_POSTS), errors };
}

// ─── Profile from script tags ─────────────────────────────────────────────────

async function extractProfileFromScripts(page: Page): Promise<ParsedProfile | null> {
  try {
    const rawUser = await page.evaluate(() => {
      for (const script of Array.from(document.querySelectorAll("script:not([src])"))) {
        const c = script.textContent ?? "";
        const m1 = c.match(/window\._sharedData\s*=\s*(\{.+?\});/s);
        if (m1) {
          try {
            const u = JSON.parse(m1[1])?.entry_data?.ProfilePage?.[0]?.graphql?.user;
            if (u?.username) return u;
          } catch {}
        }
        const m2 = c.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*(\{.+?\})\s*\)/s);
        if (m2) {
          try {
            const d = JSON.parse(m2[1]);
            const u = d?.graphql?.user ?? d?.data?.user;
            if (u?.username) return u;
          } catch {}
        }
      }
      return null;
    });
    if (!rawUser) return null;
    return parseProfileFromApiResponse({ user: rawUser }) ?? parseProfileFromApiResponse(rawUser);
  } catch { return null; }
}

// ─── DOM fallback ─────────────────────────────────────────────────────────────

async function extractProfileFromDOM(page: Page, username: string): Promise<ParsedProfile | null> {
  try {
    return await page.evaluate((uname) => {
      const parseCount = (s?: string): number | null => {
        if (!s) return null;
        s = s.replace(/,/g, "").trim();
        if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
        if (s.endsWith("K")) return Math.round(parseFloat(s) * 1_000);
        const n = parseFloat(s);
        return isNaN(n) ? null : n;
      };
      const t = document.body?.innerText ?? "";
      return {
        username: uname, displayName: null, biography: null,
        profileImageUrl: (document.querySelector("img[alt*='profile picture']") as HTMLImageElement)?.src ?? null,
        followerCount: parseCount(t.match(/([\d,.KM]+)\s*[Ff]ollowers?/)?.[1]),
        followingCount: parseCount(t.match(/([\d,.KM]+)\s*[Ff]ollowing/)?.[1]),
        totalPostCount: parseCount(t.match(/([\d,.KM]+)\s*[Pp]osts?/)?.[1]),
        isVerified: false, externalId: null,
      };
    }, username);
  } catch { return null; }
}
