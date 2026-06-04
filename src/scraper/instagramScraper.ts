/**
 * instagramScraper.ts — v7
 *
 * Fixes vs v6:
 *   - Removed --single-process (crashes Chromium on Windows)
 *   - Browser singleton resets properly on crash/disconnect
 *   - Login moved AFTER warm-up, uses a fresh page per operation
 *   - Each major step wrapped in try/catch — one failure won't kill everything
 */

import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { parseProfileFromApiResponse, ParsedProfile } from "./profileParser";
import { extractPostsFromAnyResponse, parsePostsFromEdges, parsePostsFromFeedItems, ParsedPost } from "./postParser";

export interface ScrapeResult {
  profile: ParsedProfile | null;
  posts: ParsedPost[];
  errors: string[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

const COOKIES_PATH = process.env.COOKIES_PATH
  ? path.resolve(process.env.COOKIES_PATH)
  : path.resolve(process.cwd(), "cookies.json");

const HEADLESS  = process.env.HEADLESS !== "false";
const MAX_POSTS = Number(process.env.MAX_POSTS_PER_SYNC ?? 100);
const PAGE_SIZE = 12;

const TIMELINE_QUERY_HASHES = [
  "e769aa130647d2354c40ea6a439bfc08",
  "58b6785bea111c67129decbe6a448951",
  "003056d32c2554def87228bc3fd9668a",
  "42323d64886122307be10013ad2dcc44",
  "69cba40317214fc3bbf3b3b2b4e80539",
  "472f257a40c653c64c666ce877d59d2b",
];

const TIMELINE_DOC_IDS = [
  "17888483320059182",
  "17858893269000001",
];

// ─── Browser singleton — resets on crash ─────────────────────────────────────

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
  _browser.on("disconnected", () => {
    console.log("[Scraper] Browser disconnected — will relaunch on next request");
    _browser = null;
  });
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

async function loadCookies(context: BrowserContext): Promise<boolean> {
  try {
    if (!fs.existsSync(COOKIES_PATH)) return false;
    const raw = fs.readFileSync(COOKIES_PATH, "utf-8").trim();
    if (!raw) return false;
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) return false;
    await context.addCookies(cookies);
    console.log(`[Scraper] Loaded ${cookies.length} session cookies`);
    return true;
  } catch (err) {
    console.warn("[Scraper] Cookie load failed:", (err as Error).message);
    try { fs.unlinkSync(COOKIES_PATH); } catch {}
    return false;
  }
}

async function saveCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies();
    if (cookies.length === 0) return;
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    console.log(`[Scraper] Saved ${cookies.length} cookies`);
  } catch (err) {
    console.warn("[Scraper] Cookie save failed:", (err as Error).message);
  }
}

// ─── Session warm-up ─────────────────────────────────────────────────────────
// Visits instagram.com homepage to get anonymous session tokens
// (csrftoken, ig_did, datr). Without these, profile API returns empty data.

async function warmUpSession(page: Page): Promise<void> {
  console.log("[Scraper] Warming up session — visiting instagram.com...");
  try {
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
    await randomDelay(2000, 3500);

    // Accept cookie consent dialog if shown (EU/GDPR)
    for (const sel of [
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept All")',
      'button:has-text("Allow essential and optional cookies")',
    ]) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await randomDelay(800, 1500);
        break;
      }
    }
    console.log("[Scraper] Warm-up complete");
  } catch (err) {
    console.warn("[Scraper] Warm-up partial (non-fatal):", (err as Error).message);
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function attemptLogin(page: Page): Promise<boolean> {
  const igUser = process.env.IG_USERNAME?.trim();
  const igPass = process.env.IG_PASSWORD?.trim();
  if (!igUser || !igPass) return false;

  try {
    console.log("[Scraper] Attempting login...");
    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await randomDelay(1500, 2500);

    const usernameField = page.locator('input[name="username"]');
    if (!(await usernameField.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log("[Scraper] Already logged in");
      return true;
    }

    await usernameField.fill(igUser);
    await randomDelay(400, 800);
    await page.locator('input[name="password"]').fill(igPass);
    await randomDelay(500, 900);
    await page.keyboard.press("Enter");

    // Wait for redirect away from login page
    await page.waitForURL(url => !url.toString().includes("accounts/login"), { timeout: 20_000 }).catch(() => {});
    await randomDelay(2000, 3000);

    // Dismiss post-login modals
    for (const text of ["Not Now", "Not now", "Skip", "Save Info"]) {
      const btn = page.locator(`button:has-text("${text}")`).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click().catch(() => {});
        await randomDelay(600, 1200);
      }
    }

    if (page.url().includes("challenge")) {
      console.warn("[Scraper] Login challenge detected");
      return false;
    }

    console.log("[Scraper] Login successful");
    return true;
  } catch (err) {
    console.warn("[Scraper] Login failed (non-fatal):", (err as Error).message);
    return false;
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function randomDelay(min = 1000, max = 3000): Promise<void> {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
}

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function isBlockedPage(html: string): boolean {
  if (html.length < 3000 && html.includes("challenge")) return true;
  if (html.includes('"errorCode":"challenge"')) return true;
  if (html.includes("Sorry, this page") && html.includes("unavailable")) return true;
  return false;
}

// ─── In-page authenticated fetch ─────────────────────────────────────────────

async function igFetch(page: Page, url: string): Promise<any> {
  return page.evaluate(async (fetchUrl: string) => {
    try {
      const r = await fetch(fetchUrl, {
        credentials: "include",
        headers: {
          "X-IG-App-ID": "936619743392459",
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, */*",
        },
      });
      if (!r.ok) return { __status: r.status };
      const data = await r.json().catch(() => null);
      return data ? { ...data, __status: r.status } : { __status: r.status };
    } catch (e: any) {
      return { __status: 0, __error: e?.message };
    }
  }, url);
}

// ─── Pagination helpers ───────────────────────────────────────────────────────

async function fetchFeedPage(page: Page, userId: string, maxId: string | null): Promise<{ posts: ParsedPost[]; nextMaxId: string | null } | null> {
  let url = `https://www.instagram.com/api/v1/feed/user/${userId}/?count=${PAGE_SIZE}`;
  if (maxId) url += `&max_id=${maxId}`;
  const data = await igFetch(page, url);
  if (!data || data.__status !== 200) return null;
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return { posts: parsePostsFromFeedItems(items), nextMaxId: data?.next_max_id ?? null };
}

async function fetchGraphQLPage(page: Page, userId: string, cursor: string | null): Promise<{ posts: ParsedPost[]; hasNext: boolean; endCursor: string | null } | null> {
  const variables = JSON.stringify({ id: userId, first: PAGE_SIZE, after: cursor ?? undefined });
  const encoded = encodeURIComponent(variables);

  const urlsToTry = [
    ...TIMELINE_QUERY_HASHES.map(h => `https://www.instagram.com/graphql/query/?query_hash=${h}&variables=${encoded}`),
    ...TIMELINE_DOC_IDS.map(d => `https://www.instagram.com/graphql/query/?doc_id=${d}&variables=${encoded}`),
  ];

  for (const url of urlsToTry) {
    const data = await igFetch(page, url);
    if (!data || data.__status !== 200) continue;
    const media = data?.data?.user?.edge_owner_to_timeline_media ?? data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if (!media?.edges?.length) continue;
    const pi = media.page_info ?? {};
    return { posts: parsePostsFromEdges(media.edges), hasNext: pi.has_next_page ?? false, endCursor: pi.end_cursor ?? null };
  }
  return null;
}

// ─── Main scraper ─────────────────────────────────────────────────────────────

export async function scrapeInstagramProfile(username: string): Promise<ScrapeResult> {
  const errors: string[] = [];
  let profile: ParsedProfile | null = null;
  const posts: ParsedPost[] = [];

  // Get a fresh browser — resets if crashed
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err: any) {
    return { profile, posts, errors: [`Failed to launch browser: ${err.message}`] };
  }

  const context = await browser.newContext({
    userAgent: randomUA(),
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  // Capture XHR responses automatically
  const capturedResponses: Array<{ url: string; body: any }> = [];
  context.on("response", async (response) => {
    const url = response.url();
    if (response.status() !== 200) return;
    if (!url.includes("web_profile_info") && !url.includes("/api/v1/feed/user/") && !url.includes("graphql/query")) return;
    try {
      const body = await response.json().catch(() => null);
      if (body) {
        capturedResponses.push({ url, body });
        console.log(`[Scraper] ✅ Captured: ${url.substring(0, 80)}`);
      }
    } catch {}
  });

  try {
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      // @ts-ignore
      window.chrome = { runtime: {} };
    });

    // ── STEP 0: Session setup ─────────────────────────────────────────────────
    const hadCookies = await loadCookies(context);

    if (!hadCookies) {
      console.log("[Scraper] No cookies — performing warm-up + login");
      await warmUpSession(page);
      await saveCookies(context);
    } else {
      console.log("[Scraper] Using existing session cookies");
    }

    // Login (works whether we had cookies or just warmed up)
    if (process.env.IG_USERNAME && process.env.IG_PASSWORD) {
      const ok = await attemptLogin(page);
      if (ok) await saveCookies(context);
    }

    // ── STEP 1: Load profile page ─────────────────────────────────────────────
    console.log(`\n[Scraper] ── Step 1: Loading @${username}`);
    let pageLoaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(`https://www.instagram.com/${username}/`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await randomDelay(3000, 5000);
        pageLoaded = true;
        break;
      } catch (err) {
        console.warn(`[Scraper] Page load attempt ${attempt} failed:`, (err as Error).message);
        if (attempt < 3) await randomDelay(3000, 5000);
      }
    }

    if (!pageLoaded) {
      errors.push("Failed to load profile page after 3 attempts");
      return { profile, posts, errors };
    }

    // Check for blocks
    const pageHtml = await page.content().catch(() => "");
    if (isBlockedPage(pageHtml)) {
      errors.push("Instagram returned a blocked/challenge page — cookies deleted, will retry fresh next run");
      try { fs.unlinkSync(COOKIES_PATH); } catch {}
    }

    // ── STEP 2: Extract from captured XHR ────────────────────────────────────
    console.log(`[Scraper] ── Step 2: Processing ${capturedResponses.length} XHR responses`);
    for (const { body } of capturedResponses) {
      if (!profile?.username) {
        const p = parseProfileFromApiResponse(body);
        if (p?.username) {
          profile = p;
          console.log(`[Scraper] ✅ Profile: @${profile.username} | id=${profile.externalId} | ${profile.followerCount?.toLocaleString("en-US")} followers`);
        }
      }
      const newPosts = extractPostsFromAnyResponse(body);
      if (newPosts.length > 0) {
        posts.push(...newPosts);
        console.log(`[Scraper] +${newPosts.length} posts from XHR`);
      }
    }

    // ── STEP 3: Direct API call if externalId missing ─────────────────────────
    if (!profile?.externalId) {
      console.log("[Scraper] externalId missing — direct API call");
      const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
      const data = await igFetch(page, url);
      if (data?.__status === 200) {
        const p = parseProfileFromApiResponse(data);
        if (p?.username) {
          profile = p;
          console.log(`[Scraper] ✅ Direct fetch: @${profile.username} | id=${profile.externalId}`);
        }
        const firstPosts = extractPostsFromAnyResponse(data);
        if (firstPosts.length > 0) {
          posts.push(...firstPosts);
          console.log(`[Scraper] +${firstPosts.length} posts from direct fetch`);
        }
      } else {
        console.warn(`[Scraper] Direct fetch returned ${data?.__status}`);
      }
    }

    // ── STEP 4: Script-tag + DOM fallbacks ────────────────────────────────────
    if (!profile?.username) {
      profile = await extractProfileFromScripts(page);
      if (profile?.username) console.log("[Scraper] ✅ Profile from script tags");
    }
    if (!profile?.username) {
      profile = await extractProfileFromDOM(page, username);
      if (profile?.username) console.log("[Scraper] ✅ Profile from DOM");
    }

    await saveCookies(context);

    // ── STEP 5: Pagination ─────────────────────────────────────────────────────
    const userId = profile?.externalId ?? null;

    if (!userId) {
      errors.push("Could not extract user ID — pagination skipped");
      console.warn("[Scraper] ⚠ No user ID");
    } else if (posts.length < MAX_POSTS) {
      console.log(`\n[Scraper] ── Step 3: Pagination (have ${posts.length}, want ${MAX_POSTS})`);

      // Method A: Feed API
      let paginationDone = false;
      let maxId: string | null = null;
      let feedPage = 0;
      let feedFails = 0;

      while (posts.length < MAX_POSTS && feedPage < 10 && feedFails < 3) {
        feedPage++;
        const result = await fetchFeedPage(page, userId, maxId);
        if (result && result.posts.length > 0) {
          posts.push(...result.posts);
          feedFails = 0;
          maxId = result.nextMaxId;
          paginationDone = true;
          console.log(`[FeedAPI] Page ${feedPage}: +${result.posts.length} | total=${posts.length}`);
          if (!maxId) break;
          await randomDelay(1500, 3000);
        } else {
          feedFails++;
          console.warn(`[FeedAPI] Page ${feedPage}: failed (${feedFails}/3)`);
          if (feedFails < 3) await randomDelay(2000, 4000);
        }
      }

      // Method B: GraphQL cursor
      if (!paginationDone && posts.length < MAX_POSTS) {
        console.log("[Scraper] Feed API failed — trying GraphQL");
        let cursor: string | null = null;
        let gqlFails = 0;
        for (const { body } of capturedResponses) {
          const pi = body?.data?.user?.edge_owner_to_timeline_media?.page_info;
          if (pi?.end_cursor) { cursor = pi.end_cursor; break; }
        }
        while (posts.length < MAX_POSTS && gqlFails < 3) {
          const result = await fetchGraphQLPage(page, userId, cursor);
          if (result && result.posts.length > 0) {
            posts.push(...result.posts);
            gqlFails = 0;
            cursor = result.endCursor;
            paginationDone = true;
            console.log(`[GraphQL] +${result.posts.length} | total=${posts.length}`);
            if (!result.hasNext) break;
            await randomDelay(1500, 3000);
          } else {
            gqlFails++;
            if (gqlFails < 3) await randomDelay(3000, 5000);
          }
        }
      }

      if (paginationDone) {
        console.log(`[Scraper] ✅ Pagination done — ${posts.length} posts`);
      } else {
        errors.push("Pagination limited — Instagram restricted additional requests. First batch saved.");
      }
    }

  } catch (err: any) {
    const msg = `Scraper error: ${err.message ?? String(err)}`;
    errors.push(msg);
    console.error("[Scraper]", msg);
  } finally {
    await context.close().catch(() => {});
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = posts.filter(p => {
    if (!p.shortCode || seen.has(p.shortCode)) return false;
    seen.add(p.shortCode);
    return true;
  });

  console.log(`\n[Scraper] ═══ DONE: @${username} | posts=${unique.length} | errors=${errors.length}`);
  return { profile, posts: unique.slice(0, MAX_POSTS), errors };
}

// ─── Script-tag extraction ────────────────────────────────────────────────────

async function extractProfileFromScripts(page: Page): Promise<ParsedProfile | null> {
  try {
    const rawUser = await page.evaluate(() => {
      for (const script of Array.from(document.querySelectorAll("script:not([src])"))) {
        const c = script.textContent ?? "";
        const m1 = c.match(/window\._sharedData\s*=\s*(\{.+?\});/s);
        if (m1) { try { const u = JSON.parse(m1[1])?.entry_data?.ProfilePage?.[0]?.graphql?.user; if (u?.username) return u; } catch {} }
        const m2 = c.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*(\{.+?\})\s*\)/s);
        if (m2) { try { const d = JSON.parse(m2[1]); const u = d?.graphql?.user ?? d?.data?.user; if (u?.username) return u; } catch {} }
      }
      return null;
    });
    if (!rawUser) return null;
    return parseProfileFromApiResponse({ user: rawUser }) ?? parseProfileFromApiResponse(rawUser);
  } catch { return null; }
}

// ─── DOM extraction ───────────────────────────────────────────────────────────

async function extractProfileFromDOM(page: Page, username: string): Promise<ParsedProfile | null> {
  try {
    return await page.evaluate((uname) => {
      const n = (s?: string): number | null => {
        if (!s) return null;
        s = s.replace(/,/g, "").trim();
        if (s.endsWith("M")) return Math.round(parseFloat(s) * 1e6);
        if (s.endsWith("K")) return Math.round(parseFloat(s) * 1e3);
        if (s.endsWith("B")) return Math.round(parseFloat(s) * 1e9);
        const v = parseFloat(s); return isNaN(v) ? null : v;
      };
      const t = document.body?.innerText ?? "";
      return {
        username: uname, displayName: null, biography: null,
        profileImageUrl: (document.querySelector("img[alt*='profile picture']") as HTMLImageElement)?.src ?? null,
        followerCount: n(t.match(/([\d,.KMB]+)\s*[Ff]ollowers?/)?.[1]),
        followingCount: n(t.match(/([\d,.KMB]+)\s*[Ff]ollowing/)?.[1]),
        totalPostCount: n(t.match(/([\d,.KMB]+)\s*[Pp]osts?/)?.[1]),
        isVerified: false, externalId: null,
      };
    }, username);
  } catch { return null; }
}