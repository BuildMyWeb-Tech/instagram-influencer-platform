# 📊 Instagram Influencer Platform (POC)

A real-data influencer analytics platform that scrapes Instagram **without the Graph API** using Playwright browser automation.

---

## 🏗️ Architecture

```
src/
├── server.ts                  # Express server entry
├── api/
│   └── routes.ts              # API endpoints
├── scraper/
│   ├── instagramScraper.ts    # Core Playwright scraper
│   ├── profileParser.ts       # Profile data extraction
│   └── postParser.ts          # Post data extraction
├── services/
│   └── syncService.ts         # Scrape → DB orchestration
└── db/
    └── prismaClient.ts        # Prisma singleton

prisma/
└── schema.prisma              # DB schema
```

---

## ⚡ Quick Start

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Start PostgreSQL

```bash
docker-compose up -d postgres
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL, optionally IG_USERNAME + IG_PASSWORD
```

### 4. Initialize database

```bash
npx prisma db push        # Push schema (no migration files)
# OR
npx prisma migrate dev    # With migration history
```

### 5. Start the server

```bash
npm run dev
```

---

## 🧪 Test Scraper Without Server

```bash
# Test scraping directly (no DB needed)
npx ts-node src/testScraper.ts natgeo
npx ts-node src/testScraper.ts nike
```

---

## 📡 API Reference

### `POST /api/sync`

Trigger a scrape + store for an Instagram username.

```bash
curl -X POST http://localhost:3000/api/sync \
  -H "Content-Type: application/json" \
  -d '{"username": "natgeo"}'
```

**Response:**
```json
{
  "username": "natgeo",
  "postsCollected": 42,
  "newPosts": 12,
  "updatedPosts": 30,
  "profile": {
    "id": "clxyz...",
    "followers": 281000000,
    "displayName": "National Geographic",
    "totalPosts": 30000
  },
  "errors": [],
  "durationMs": 18432,
  "status": "success"
}
```

**Status codes:**
- `200` — full success
- `207` — partial (some posts failed, but data was saved)
- `500` — complete failure

---

### `GET /api/profile/:username`

Get stored influencer data + all posts.

```bash
curl http://localhost:3000/api/profile/natgeo
```

---

### `GET /api/profile/:username/posts?limit=50&offset=0`

Paginated posts for a profile.

```bash
curl "http://localhost:3000/api/profile/natgeo/posts?limit=20&offset=0"
```

---

### `GET /api/profile/:username/history`

Sync history and status for an account.

---

### `GET /api/influencers`

List all tracked influencers.

---

### `GET /api/health`

Health check (tests DB connection).

---

## 🔐 Authentication (Optional but Recommended)

Set credentials in `.env`:
```env
IG_USERNAME=your_throwaway_account
IG_PASSWORD=your_password
```

Using a logged-in session significantly improves:
- Number of posts accessible
- Data completeness (likes, comments)
- Rate limit tolerance

**Use a dedicated throwaway account — never your main account.**

---

## 🛡️ Anti-Detection Features

- Random 1–5s delays between requests
- Rotating realistic User-Agent strings
- Cookie persistence (`cookies.json`) to reuse sessions
- `navigator.webdriver` spoofing
- Human-like scroll behavior
- `--disable-blink-features=AutomationControlled` Chromium flag

---

## 🔄 Extraction Strategy (Fallback Chain)

1. **XHR Interception** — captures Instagram's internal API responses (`/api/v1/users/web_profile_info`, `/api/v1/feed/user/`)
2. **Script Tag Mining** — extracts `window._sharedData` / `__additionalDataLoaded` JSON blobs
3. **`?__a=1` Endpoint** — fetches the legacy JSON endpoint via `fetch()` in-browser
4. **DOM Scraping** — reads follower counts and display names from visible text
5. **Meta Tags** — falls back to `og:description` and `og:image` for minimal profile data

---

## ⚠️ Known Limitations

| Issue | Behavior |
|-------|----------|
| Instagram blocks the IP | Errors logged, partial data saved if available |
| Challenge/CAPTCHA page | Sync marked as `partial` or `failed` |
| Private accounts | Profile visible, posts unavailable |
| Like counts hidden | `likesCount: null` stored, not an error |
| Rate limiting | Random delays help; use session cookies |

---

## 🗄️ Database Schema

```
Influencer
  id, username, displayName, biography
  profileImageUrl, followerCount, followingCount
  totalPostCount, isVerified, externalId
  lastSyncedAt, createdAt, updatedAt

Post
  id, influencerId, postUrl, shortCode
  caption, mediaType, mediaUrl, thumbnailUrl
  likesCount, commentsCount, viewsCount
  publishedAt, collectedAt

SyncLog
  id, username, status, postsCollected
  newPosts, errorMessage, durationMs, createdAt
```

---

## 🧰 Useful Commands

```bash
# View DB in Prisma Studio
npx prisma studio

# Reset DB
npx prisma db push --force-reset

# Check sync logs
psql $DATABASE_URL -c "SELECT * FROM \"SyncLog\" ORDER BY \"createdAt\" DESC LIMIT 10;"

# Count posts per influencer
psql $DATABASE_URL -c "SELECT i.username, COUNT(p.id) FROM \"Influencer\" i LEFT JOIN \"Post\" p ON p.\"influencerId\" = i.id GROUP BY i.username;"
```

---

## ⚖️ Legal Notice

This POC is for **educational and research purposes only**. Scraping Instagram may violate their Terms of Service. Do not use against accounts without permission or at scale in production. Always comply with applicable laws and platform policies.
