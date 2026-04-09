# app-ads.txt Crawler

A web tool to crawl `app-ads.txt` and `ads.txt` files from app bundle IDs and web domains, with keyword search and real-time streaming results.

## Setup

```bash
npm install
node server.js
```

Then open: http://localhost:3000

## How it works

1. **Choose input mode** — Bundle IDs, Web URLs, or Direct URLs
2. **Select platform** — Android, iOS, Amazon, or All
3. **Add keywords** to search for in the ads.txt file
4. **Run the crawler** — results stream in real-time
5. **Filter and export** results as CSV, JSON, or Excel

## Input modes

- **Bundle IDs** — looks up developer URL from the app store, then fetches `app-ads.txt`
- **Web URLs** — fetches `ads.txt` from the root of each domain
- **Direct URLs** — fetches the URL as-is (paste full `app-ads.txt` / `ads.txt` URLs)

## Supported formats

- **Android**: `com.example.app`
- **iOS numeric**: `123456789` or `id123456789`
- **iOS bundle**: `com.example.app`
- **Amazon**: `B00OGRMULA` (ASIN)

## File upload

Drop or browse CSV, TXT, Excel (.xlsx/.xls), or PDF files to bulk-load inputs in any mode.

## Keyword matching

| Format | Behaviour |
|---|---|
| `pubmatic` | Token search — all tokens must appear on the same line |
| `google.com, pub-123, DIRECT` | Field-by-field ads.txt line match (exact or partial) |
| Multi-line paste | Block match — each pasted line matched independently; missing lines highlighted |

Keywords can be set to **Include** or **Exclude** mode per tag.

## Developer URL discovery

- **Android**: scrapes Google Play store page for external developer URLs
- **iOS**: iTunes Lookup API (`sellerUrl`), falls back to App Store page scrape
- **Amazon**: scrapes Amazon product page for developer website link

## Rate limiting

Runs 6 concurrent requests with per-request timeouts (10s store lookups, 8s ads.txt fetches).
