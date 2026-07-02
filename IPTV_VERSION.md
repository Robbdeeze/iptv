# IPTV Version & Architecture Document

**Version:** 1.13.0

## Repository: Robbdeeze/iptv

A forked/cloned IPTV project based on [iptv-org/iptv](https://github.com/iptv-org/iptv) that collects publicly available IPTV stream URLs and generates custom playlists with Electronic Program Guide (EPG) data. This document provides a detailed breakdown of every component, how they work, and how the entire pipeline fits together.

## 0. Pipeline Architecture

```
iptv-org API (channels, streams, guides)
        │
        ▼
  loadData() ────────────────────────────┐
        │                                │
        ▼                                ▼
  streams/*.m3u                  External M3U sources
  (countries/ + sources/)         (YueChan, DrewLive, IPTVjs)
        │                                │
        └──────────┬─────────────────────┘
                   │
                   ▼
              Famelack data
                   │
                   ▼
             Sports scrapers (16x parallel)
             DaddyLive  | Streamed   | NTV         | SportsBite
             PPV.TO     | Roxie      | SportyHunter | VIPRow
             Sportsurge | StreamEast | LiveTV      | Portals
             DLHD       | RabbitMeow | TheTVApp    | TotalSportek
                   │
                   ▼
            Dedup by URL → Reorganize → 19 sections
                   │
       ┌───────────┼───────────┐──────────────────┐
       ▼           ▼           ▼                  ▼
  UltimateTV   Clean.m3u    EPG builder    Health Check
     .m3u                   (built-in +     (hourly, HTTP
                             Docker)        only, --fix)
```

---

## Table of Contents

0. [Pipeline Architecture](#0-pipeline-architecture)
1. [Project Overview](#1-project-overview)
2. [Key Output Files](#2-key-output-files)
3. [GitHub Actions Workflows](#3-github-actions-workflows)
   - [ultimate.yml (Daily)](#31-ultimateyml---daily-ultimate-playlist--epg)
   - [merge-all.yml (Every 3 Days)](#32-merge-allyml---every-3-days)
   - [check.yml (PR Validation)](#33-checkyml---pr-validation)
   - [health-check.yml (Every 60 min)](#34-health-checkyml---every-60-minutes)
4. [Playlist Generation Scripts](#4-playlist-generation-scripts)
   - [generateUltimate.ts](#41-generateultimatets)
   - [mergeAllM3u.ts](#42-mergeallm3uts)
   - [generate.ts (Standard Playlists)](#43-generatets)
5. [EPG Generation](#5-epg-generation)
   - [Path A: Built-in EPG (in generateUltimate.ts)](#51-path-a-built-in-epg)
   - [Path B: Docker-based EPG (generateEpg.ts + iptv-org/epg)](#52-path-b-docker-based-epg)
   - [generateEpg.ts Details](#53-generateepgts-details)
6. [Sports Scrapers](#6-sports-scrapers)
    - [daddyliveScraper.ts](#61-daddylivescraperts)
    - [streamedScraper.ts](#62-streamedscraperts)
    - [aggregatorHelpers.ts](#63-aggregatorhelpersts)
    - [ntvScraper.ts](#64-ntvscraperts)
    - [sportsBiteScraper.ts](#65-sportsbitescraperts)
    - [ppvToScraper.ts](#66-ppvtoscraperts)
    - [roxieScraper.ts](#67-roxiescraperts)
    - [sportyHunterScraper.ts](#68-sportyhunterscraperts)
    - [vipboxScraper.ts](#69-vipboxscraperts)
    - [sportsurgeScraper.ts](#610-sportsurgescraperts)
    - [streamEastScraper.ts](#611-streameastscraperts)
    - [liveTvScraper.ts](#612-livetvscraperts)
    - [portalScraper.ts](#613-portalscraperts)
    - [dlhdScraper.ts](#614-dlhdscraperts)
    - [rabbitMeowScraper.ts](#615-rabbitmeowscraperts)
    - [theTvAppScraper.ts](#616-thetvappscraperts)
    - [totalSportekScraper.ts](#617-totalsportekscraperts)
  7. [Project File Structure](#7-project-file-structure)
8. [Script Reference (npm commands)](#8-script-reference)
9. [Dependencies](#9-dependencies)
10. [Testing](#10-testing)
11. [Recent Improvements](#11-recent-improvements)
12. [Stream Health Check System](#12-stream-health-check-system)
13. [How to Run Locally](#13-how-to-run-locally)

---

## 1. Project Overview

This project is a **TypeScript/Node.js** application that:

- Maintains a curated collection of free, publicly available TV stream links organized by country in `streams/` (e.g., `us.m3u`, `fr.m3u`, `uk.m3u`)
- Generates **public playlists** (M3U format) grouped by category, language, country, region, city, and source
- Generates a **custom "UltimateTV" playlist** (`Robbdeeze_UltimateTV.m3u`) that merges US/CA/UK streams, external sources, local VOD files, and scraped sports streams
- Generates **Electronic Program Guide (EPG)** XML data for channels with configurable coverage (currently 3 days)
- Automates everything via **GitHub Actions workflows** running daily and every 3 days

The project uses the **iptv-org ecosystem** extensively:
- **@iptv-org/sdk** — Provides data models and types for channels, streams, and guides
- **iptv-org/epg** (Docker image) — Scrapes EPG data from various providers (Schedules Direct, WebGrab+, etc.)
- **iptv-org/api** — API that provides channel/stream/guide JSON data
- **iptv-org/database** — Master channel database

---

## 2. Key Output Files

All generated files live in the repository root:

| File | Description | Generated By |
|------|-------------|-------------|
| `Robbdeeze_UltimateTV.m3u` | Custom playlist: US/CA/UK streams + external playlists + sports scrapers (VOD-free) | `playlist:ultimate` |
| `Robbdeeze_UltimateTV_AllM3uMerged.m3u` | All streams from `streams/` merged (VOD-free) | `playlist:mergeAll` |
| `streams/vod/movies.m3u` | VOD Movies (not embedded in live playlists) | Copied from source |
| `streams/vod/tv-shows.m3u` | VOD TV Shows (not embedded in live playlists) | Copied from source |
| `Robbdeeze_UltimateTV_Epg.xml` | EPG XML for the UltimateTV playlist | `generateUltimate.ts` (built-in) |
| `Robbdeeze_UltimateTV_Epg.xml.gz` | Gzipped version of the EPG | `generateUltimate.ts` (built-in) |
| `Robbdeeze_UltimateTV_AllM3uMerged_Epg.xml` | EPG XML for the merged playlist | `generateEpg.ts` + Docker |
| `Robbdeeze_UltimateTV_AllM3uMerged_Epg.xml.gz` | Gzipped version | `generateEpg.ts` + Docker |
| `channels.xml` | Intermediate file: maps tvg-ids to EPG sites | `generateEpg.ts --channels-xml` |
| `guide.xml` | Intermediate file: raw EPG from Docker container | Docker `iptv-org/epg` |

Public URLs (served via GitHub raw):
- Playlist: `https://raw.githubusercontent.com/Robbdeeze/iptv/master/Robbdeeze_UltimateTV.m3u`
- Clean: `https://raw.githubusercontent.com/Robbdeeze/iptv/master/Robbdeeze_UltimateTV_Clean.m3u`
- Merged: `https://raw.githubusercontent.com/Robbdeeze/iptv/master/Robbdeeze_UltimateTV_AllM3uMerged.m3u`
- VOD Movies: `https://raw.githubusercontent.com/Robbdeeze/iptv/master/streams/vod/movies.m3u`
- VOD TV Shows: `https://raw.githubusercontent.com/Robbdeeze/iptv/master/streams/vod/tv-shows.m3u`
- EPG XML: `https://raw.githubusercontent.com/Robbdeeze/iptv/master/Robbdeeze_UltimateTV_Epg.xml`
- EPG GZ: `https://raw.githubusercontent.com/Robbdeeze/iptv/master/Robbdeeze_UltimateTV_Epg.xml.gz`

---

## 3. GitHub Actions Workflows

### 3.1 `ultimate.yml` — Daily Ultimate Playlist + EPG

**Trigger:** Every 24 hours at midnight (`0 0 */1 * *`) + manual `workflow_dispatch`.

**Pipeline:**

```
Step 1: Checkout repository (full depth)
Step 2: Setup Node.js 22 with npm caching
Step 3: npm install (postinstall runs api:load automatically)
Step 4: npx playwright install chromium
Step 5: npm run playlist:ultimate
    - Loads API data (channels, streams, guides from iptv-org)
    - Parses US/CA/UK M3U files from streams/
     - Fetches external playlists (YueChan Global, Radio, IPTVjs Adult, DrewLive Merged, MadTitan, PixelSport, TVPass)
    - VOD playlists available separately under streams/vod/ (not embedded in main playlist)
    - Fetches Famelack US/UK channel data, saves to streams/
    - Scrapes DaddyLive sports streams via Playwright
    - Scrapes Streamed.pk sports streams via Playwright
    - Scrapes NTV sports streams via Playwright + page parsing
    - Scrapes SportsBite event streams via Playwright
    - Scrapes PPV.TO live event streams via Playwright
    - Scrapes RoxieStreams sports via Playwright
    - Scrapes SportyHunter events via Playwright
    - Scrapes Sportsurge events via Playwright
    - Scrapes StreamEast events via Playwright
    - Scrapes LiveTV events via Playwright
    - Deduplicates by URL
    - Sorts by group-title, title, resolution (desc)
    - Writes Robbdeeze_UltimateTV.m3u with x-tvg-url header
    - Downloads and compiles EPG from guide URLs
    - Writes Robbdeeze_UltimateTV_Epg.xml and .xml.gz
Step 6: npx tsx generateEpg.ts --channels-xml channels.xml
    - Reads Robbdeeze_UltimateTV.m3u
    - Extracts all unique tvg-ids
    - Downloads guides.json from iptv-org.github.io/api/guides.json
    - Generates channels.xml mapping channels to EPG sites
Step 7: Docker run iptv-org/epg
    - Mounts $PWD as /epg/public
    - MAX_CONNECTIONS=5, DAYS=3
    - Polls every 60s for up to 240 minutes (4 hours)
    - Downloads guide.xml when ready
    - Graceful stop with || true to prevent workflow failure on cleanup
Step 8: npx tsx generateEpg.ts --process-guide guide.xml
    - Filters guide.xml to only channels in Robbdeeze_UltimateTV.m3u
    - Outputs Robbdeeze_UltimateTV_Epg.xml and .xml.gz
Step 9: Check for git changes (git status --porcelain)
Step 10: If changes exist, commit and push:
    - Commit message: "[Bot] Update Robbdeeze_UltimateTV playlist and EPG"
    - Files: Robbdeeze_UltimateTV.m3u, *_Epg.xml, *_Epg.xml.gz, streams/*.m3u
```

### 3.2 `merge-all.yml` — Every 3 Days

**Trigger:** Every 3 days at midnight (`0 0 */3 * *`) + manual dispatch.

**Pipeline:**

```
Step 1: Checkout repo
Step 2: Setup Node.js 22 with npm cache
Step 3: npm ci --ignore-scripts
Step 4: npm run playlist:mergeAll
    - Parses ALL M3U files in streams/ (deduplicating by URL)
    - VOD playlists available separately under streams/vod/ (not embedded in merged playlist)
    - Sorts by group-title, title, resolution
    - Writes Robbdeeze_UltimateTV_AllM3uMerged.m3u
Step 5: generateEpg.ts --channels-xml channels.xml (for merged playlist)
Step 6: Docker run iptv-org/epg with DAYS=1
    - Polls for up to 3 hours (180 iterations * 60s)
Step 7: generateEpg.ts --process-guide (output name: Robbdeeze_UltimateTV_AllM3uMerged_Epg)
Step 8: Validate links (random sample of 100 URLs checked with curl)
Step 9: Commit and push
```

### 3.3 `check.yml` — PR Validation

**Trigger:** `pull_request` events (opened, synchronized, reopened).

**Pipeline:**

```
Step 1: Checkout repo + fetch master branch
Step 2: Detect changed files in streams/
Step 3: If any changed:
    - Setup Node.js 22
    - npm install
    - npm run playlist:lint -- <changed files> (M3U syntax linting via m3u-linter)
    - npm run playlist:validate -- <changed files> (ID/URL validation)
    - Blocks merge if errors found
```

### 3.4 `health-check.yml` — Every 60 Minutes

**Trigger:** Every 60 minutes (`0 * * * *`) + manual `workflow_dispatch`.

**Pipeline:**

```
Step 1: Checkout repository
Step 2: Setup Node.js 22 with npm caching
Step 3: npm install --ignore-scripts
Step 4: npm run playlist:health:fix
    - Parses all M3U files in streams/**/*.m3u
    - For each stream: HEAD request (10s timeout) → GET with Range fallback
    - 50 concurrent workers
    - Removes streams that fail with ECONNREFUSED, ENOTFOUND, 404, 410, etc.
    - Rewrites modified files via Playlist.toString()
Step 5: Check for git changes (git status --porcelain)
Step 6: If changes exist, commit and push:
    - Commit message: "[Bot] Remove dead streams (health check)"
    - Files: streams/**/*.m3u
```

---

## 4. Playlist Generation Scripts

### 4.1 `generateUltimate.ts`

**Location:** `scripts/commands/playlist/generateUltimate.ts` (400 lines)

**Command:** `npm run playlist:ultimate`

This is the **core custom script** that builds the Robbdeeze UltimateTV experience. It produces both the playlist and EPG in a single run.

**Detailed workflow:**

1. **Load API data** — Calls `loadData()` which downloads channel/stream/guide data from iptv-org API into `temp/data/`

2. **Parse local streams** — Scans `streams/` for files starting with US, CA, UK (case-insensitive), excluding auto-generated famelack files. Each file gets a group-title based on its filename:
   - `us.m3u` → `"United States"`
   - `us_pluto.m3u` → `"US - Pluto"`
   - `uk_bbc.m3u` → `"UK - BBC"`

3. **Fetch external playlists** (with 15s timeout per URL):
   - `YueChan Live/Global.m3u` → group: `"YueChan - Global"`
   - `YueChan Live/Radio.m3u` → group: `"YueChan - Radio"`
   - `iptvjs/adultiptv_all.m3u` → group: `"! Adult"`
   - 25 `live.adultiptv.net/{category}.m3u8` URLs → group: `"! Adult"`
   - `DrewLiveMergedPlaylist.m3u8` → preserves original group titles (A1xmedia, PlutoTV, SamsungTVPlus, etc.)
   - `MadTitan.m3u8` → preserves original group titles (24/7 shows, UFC, kids)
   - `Pixelsports.m3u8` → preserves original group titles (NBA, NHL, NFL, MLB live games)
   - `TVPass.m3u` → preserves original group titles (US cable/network channels)

4. **VOD available separately** — VOD playlists are no longer embedded in the main playlist. They are distributed independently as separate files under `streams/vod/movies.m3u` and `streams/vod/tv-shows.m3u` and linked from README.

5. **Fetch Famelack data** — Downloads JSON from `famelack/famelack-data` for US and UK, converts to M3U format, saves individual files to `streams/us_famelack.m3u` and `streams/uk_famelack.m3u`, assigns group `"Famelack - US"` / `"Famelack - UK"`

6. **Scrape DaddyLive sports** — See scraper section below

7. **Scrape Streamed.pk sports** — See scraper section below

8. **Scrape NTV channels** — See scraper section below

9. **Scrape SportsBite events** — See scraper section below

10. **Scrape PPV.TO events** — See scraper section below

11. **Scrape RoxieStreams events** — See scraper section below

12. **Scrape SportyHunter events** — See scraper section below

13. **Deduplicate** — Streams are deduplicated by URL using `Collection.uniqBy()`

14. **Sort** — By group-title (asc), title (asc), resolution/vertical resolution (desc)

15. **Write playlist** — Outputs `Robbdeeze_UltimateTV.m3u` with a custom `#EXTM3U x-tvg-url="Robbdeeze_UltimateTV_Epg.xml.gz"` header pointing to our own EPG

16. **Build EPG** — See EPG section (Path A) below

### 4.2 `mergeAllM3u.ts`

**Location:** `scripts/commands/playlist/mergeAllM3u.ts` (165 lines)

**Command:** `npm run playlist:mergeAll`

A simpler script that merges **all** streams from `streams/` directory into one playlist. Uses a comprehensive `COUNTRY_NAMES` mapping (200+ countries) to convert country codes to human-readable names.

**Group-title logic:**
- `us.m3u` → `"United States"`
- `us_pluto.m3u` → `"United States - Pluto"`
- `fr.m3u` → `"France"`
- `de_samsung.m3u` → `"Germany - Samsung"`

**VOD playlists** are available separately under `streams/vod/` but are no longer embedded in the merged playlist.

**Deduplication** uses a `Set<string>` of seen URLs during parsing (before sorting).

**Manual M3U construction** — Unlike generateUltimate which uses the `Playlist` class, this script builds the M3U string manually for simplicity.

### 4.3 `generate.ts`

**Location:** `scripts/commands/playlist/generate.ts`

**Command:** `npm run playlist:generate`

Generates the **full set of public playlists** for iptv-org style deployment (output to `.gh-pages/`):

- `raw/{filename}.m3u` — Per-country files with categories as group-titles
- `categories/{id}.m3u` — Streams by category (Animation, Sports, News, etc.)
- `languages/{code}.m3u` — Streams by language
- `countries/{code}.m3u` — Streams by country
- `subdivisions/{code}.m3u` — Streams by administrative subdivision
- `cities/{code}.m3u` — Streams by city
- `regions/{code}.m3u` — Streams by region
- `sources/{source}.m3u` — Streams by source URL
- `index.m3u` — All SFW streams
- `index.category.m3u` — Index of category playlists
- `index.country.m3u` — Index of country playlists (hierarchical)
- `index.language.m3u` — Index of language playlists

---

## 5. EPG Generation

### 5.1 Path A: Built-in EPG

**Inside `generateUltimate.ts`** (lines 283-386)

After building the UltimateTV playlist, the script builds EPG data directly:

1. **Collect tvg-ids** — Iterates all streams in the combined playlist, collecting unique tvg-id values into a `Set<string>` (typically hundreds to thousands)

2. **Get guide URLs** — Calls `playlist.getGuideUrls()` which aggregates all guide source URLs from the `@iptv-org/sdk` guide data associated with each stream's channel

3. **Download guides in parallel** — Uses `async.eachLimit` with concurrency of 3:
   - Downloads each guide URL via axios with 30s timeout
   - Handles gzip content encoding (both `.gz` URLs and `Content-Encoding: gzip` responses)
   - Parses XML via regex

4. **Match channels** — Uses regex to find `<channel>` elements whose `id` attribute matches a tvg-id in the playlist

5. **Match programmes** — Uses regex to find `<programme>` elements whose `channel` attribute matches a tvg-id in the playlist

6. **Assemble XML** — Builds the final XMLTV document with `<tv>` root element containing all matched channels and programmes

7. **Save files** — Writes `Robbdeeze_UltimateTV_Epg.xml` and gzips to `Robbdeeze_UltimateTV_Epg.xml.gz`

**Stats logged:** Number of channels matched, programmes matched, file sizes.

**Warning:** If 0 channels match, a warning is logged suggesting a tvg-id extraction issue.

### 5.2 Path B: Docker-based EPG

**Used by both workflows** for a more comprehensive EPG via `iptv-org/epg`.

**Phase 1: Generate `channels.xml`**

`npx tsx scripts/commands/playlist/generateEpg.ts --channels-xml channels.xml`

- Reads the M3U playlist
- Extracts all unique base tvg-ids (splitting on `@` to separate feed IDs like `CNN.us@SD`)
- Downloads `guides.json` from `https://iptv-org.github.io/api/guides.json`
- Matches each base channel ID to EPG site entries
- For each match, selects the best feed (prefers the specific feed ID, then English, then first available)
- Generates `channels.xml` mapping channels to EPG sites (e.g., Schedules Direct, WebGrab+, etc.)

**Phase 2: Docker container**

```bash
docker run -d --name epg \
  -v $PWD:/epg/public:Z \
  -p 3000:3000 \
  -e MAX_CONNECTIONS=5 \
  -e DAYS=3 \
  ghcr.io/iptv-org/epg:master
```

- The container reads `channels.xml` from the mounted `/epg/public` directory
- Scrapes EPG data from each configured site/provider
- `MAX_CONNECTIONS=5` limits concurrent scraping connections
- `DAYS=3` requests 3 days of programme data (configurable)
- `RUN_AT_STARTUP=true` triggers generation immediately
- Generates `guide.xml` accessible at `http://localhost:3000/guide.xml`

The workflow polls every 60 seconds for up to **240 iterations** (4 hours), checking for HTTP 200 on `guide.xml`. On success it downloads the file.

**Phase 3: Process and filter**

`npx tsx scripts/commands/playlist/generateEpg.ts --process-guide guide.xml`

- Reads the full `guide.xml` from the Docker container
- Filters to keep only channels and programmes matching tvg-ids in the M3U playlist
- Saves the filtered XML and GZ version

### 5.3 `generateEpg.ts` Details

**Location:** `scripts/commands/playlist/generateEpg.ts` (170 lines)

**Two operation modes:**

1. **`--channels-xml [path]`** — Generates `channels.xml` from an M3U playlist. Extracts tvg-ids, downloads guides.json from iptv-org, matches channels to EPG sites, outputs channel mappings.

2. **`--process-guide <path>`** — Filters a pre-built `guide.xml` (from Docker) to only include channels/programmes matching the M3U playlist's tvg-ids.

**Key functions:**
- `extractTvgIds()` — Parses M3U content for `tvg-id="..."` attributes, groups by base ID (splitting on `@`)
- `generateChannelsXml()` — Matches channel IDs to EPG site data, generates channel mappings
- `processGuide()` — Filters guide.xml to matching channels, saves filtered XML + gzip

**Safety feature:** After filtering, if `matchedChannels.length === 0`, logs a warning: `"No channels matched! Check tvg-id extraction."`

---

## 6. Sports Scrapers

### 6.1 `daddyliveScraper.ts`

**Location:** `scripts/commands/playlist/daddyliveScraper.ts` (590 lines)

**Group title:** `"! Sports - DaddyLive"`

Scrapes live sports streams from daddylive.org / daddylivehd.

**Architecture:**

1. **Find active domain** — Fetches `https://daddylive.org/`, looks for the "DaddyLiveHD Live Sports Stream Online Free HD" section, then searches for the "Active" domain entry (matching patterns like `daddylive`, `streameast`, `dlhd`). Multiple regex fallback strategies.

2. **Fetch player data** — Downloads `{domain}/embed/embed.php?id=32&player=1&source=tv.json`, extracts the `player9Data` JavaScript array containing channel entries with names and m3u8 URLs.

3. **Filter sports channels** — Applies a 60+ pattern keyword filter to identify sports channels (patterns include: `sport`, `espn`, `nfl`, `nba`, `nhl`, `mlb`, `ufc`, `dazn`, `bein sport`, plus major broadcasters like `bbc one`, `itv`, `cbs`, `sky sport`, etc.)

4. **Fetch events API** — Calls `{domain}/api/events` for additional live event data, filtered to interesting categories (soccer, football, basketball, tennis, etc.)

5. **Extract event streams** — For each event channel:
   - If it has a real name → finds the m3u8 URL via `findMatch()` against `player9Data`
   - If it's a generic "Link - N" event → uses Playwright headless browser to intercept network traffic and capture m3u8 URLs, plus fallback to dlhd URL patterns

6. **Deduplication** — Uses a `Set<string>` of seen URLs

7. **Browser management** — Singleton Chromium instance shared across all event extractions, properly closed at the end

**Key pattern matching:** The `findMatch()` function uses a multi-strategy approach:
1. Exact name match
2. startsWith match (bidirectional)
3. Word containment (every word must be present)

### 6.2 `streamedScraper.ts`

**Location:** `scripts/commands/playlist/streamedScraper.ts` (248 lines)

**Group title:** `"! Sports - Streamed"`

Scrapes live sports streams from streamed.pk.

**Architecture:**

1. **Get sports categories** — Calls `{domain}/api/sports` to get all sport types (soccer, basketball, tennis, etc.)

2. **Fetch matches per sport** — For each sport, calls `{domain}/api/matches/{sportId}` to get available matches with teams, titles, and source IDs

3. **Get stream options per source** — For each match source, calls `{domain}/api/stream/{source}/{id}` to get available stream options with language, HD flag, and embed URL

4. **Select best stream** — Preference order:
   - English HD streams
   - English (any quality)
   - First available

5. **Extract m3u8 from embed** — Uses Playwright headless browser to navigate to the embed URL, intercepts network requests for `.m3u8` and `.mpd` URLs, also checks DOM for video/iframe sources

6. **Deduplication** — By URL

7. **Browser management** — Singleton Chromium instance, properly closed

---

### 6.3 `aggregatorHelpers.ts`

**Location:** `scripts/core/aggregatorHelpers.ts` (121 lines)

**Purpose:** Shared utility module that extracts common functionality from daddyliveScraper into reusable functions used by all new scrapers. Reduces code duplication and ensures consistent Playwright browser management.

**Exported functions:**

| Function | Description |
|----------|-------------|
| `getBrowser()` | Singleton Chromium launcher (headless, no-sandbox). Creates one browser instance shared across all calls within a single run. |
| `closeBrowser()` | Closes the shared browser instance and nulls the reference. Must be called at the end of each scrape. |
| `extractM3u8FromEmbed(embedUrl, logger)` | Opens a headless Chromium page, intercepts all network requests/responses for `.m3u8` and `.mpd` URLs, also inspects DOM for video/iframe sources. Returns the first found m3u8 URL or null. |
| `createStream(title, url, groupTitle, tvgId?)` | Factory function that creates a `Stream` object with all required fields (channel null, feed null, quality null, etc.) and sets groupTitle, tvgId, tvgLogo. |
| `fetchWithTimeout(url, timeout?)` | Simple axios GET wrapper with error handling. Returns response data as string or null on failure. Default timeout 15s. |

---

### 6.4 `ntvScraper.ts`

**Location:** `scripts/commands/playlist/ntvScraper.ts`

**Group title:** `"! Sports - NTV"`

**Mirrors:** `ntvs.cx`, `ntv.cx`, `ntv.lol`

Scrapes live channels and streams from NTV aggregator sites.

**Architecture:**

1. **Find active mirror** — Tries each mirror URL in order, fetches the homepage, checks for "ntv" in response
2. **Extract channels** — Parses homepage HTML for `<a>` links:
   - Direct `.m3u8` links are captured immediately
   - Watch/live/stream/channel links are captured as "page" sources for deeper extraction
   - Falls back to extracting `<iframe>` embed URLs if no direct links found
3. **Resolve stream URLs** — For each channel:
   - Direct m3u8 URLs are used as-is
   - Embed sources use `extractM3u8FromEmbed()` with Playwright
   - Page sources are fetched via HTTP, then checked for m3u8 patterns, iframe embeds, and Playwright fallback
4. **Deduplication** — By URL using `Set<string>`
5. **Browser cleanup** — Calls `closeBrowser()` at end

### 6.5 `sportsBiteScraper.ts`

**Location:** `scripts/commands/playlist/sportsBiteScraper.ts`

**Group title:** `"! Sports - SportsBite"`

**Mirrors:** `sportsbite.lol`, `sportsbite.xyz`, `sportsbite.site`

Scrapes live sports events from SportsBite aggregators.

**Architecture:**

1. **Find active mirror** — Probes each mirror for sports-related content
2. **Extract events** — Parses homepage for `<a>` links matching vs-patterns (e.g., "Team A vs Team B") or containing watch/live/stream/event/game in href. Extracts league info from URL path segments.
3. **Resolve event streams** — For each event URL:
   - HTTP fetch for direct m3u8 patterns
   - iframe extraction for embedded players
   - Playwright browser interception as final fallback
4. **Limits** — Processes up to 30 events per run to balance runtime vs. coverage
5. **Deduplication** — By URL

### 6.6 `ppvToScraper.ts`

**Location:** `scripts/commands/playlist/ppvToScraper.ts`

**Group title:** `"! Sports - PPV"`

**Base URL:** `https://ppv.to`

Scrapes PPV and live event streams from ppv.to.

**Architecture:**

1. **Extract events** — Parses homepage for `<a>` links matching vs-patterns, PPV keywords (watch, live, ppv, event, stream). Extracts category from URL path segments.
2. **Resolve m3u8 from page** — Multi-strategy extraction:
   - HTTP fetch for direct m3u8 patterns
   - iframe extraction
   - JavaScript variable patterns (`src:`, `file:`) for player configs
   - Playwright browser interception as fallback
3. **Limits** — Up to 25 events per run
4. **Deduplication** — By URL

### 6.7 `roxieScraper.ts`

**Location:** `scripts/commands/playlist/roxieScraper.ts`

**Group title:** `"! Sports - Roxie"`

**Mirrors:** `roxiestreams.info`, `roxiestreams.live`, `roxiesports.com`

Scrapes sports streams from RoxieStreams aggregators.

**Architecture:**

1. **Find active mirror** — Probes each mirror for stream/sport content
2. **Extract events** — Two extraction methods:
   - HTML `<a>` parsing for vs-patterns, watch/live/stream/game/event links
   - Inline JSON parsing for `var streams = [...]` patterns with pre-defined m3u8 URLs
3. **Resolve streams** — Direct m3u8 URLs from JSON, or page-based extraction (HTTP fetch → iframe → Playwright) for event links
4. **Limits** — Up to 25 events per run
5. **Deduplication** — By URL

### 6.8 `sportyHunterScraper.ts`

**Location:** `scripts/commands/playlist/sportyHunterScraper.ts`

**Group title:** `"! Sports - SportyHunter"`

**Mirrors:** `sportyhunter.com`, `sportyhunter.lol`, `sportyhunter.xyz`

Scrapes sports events and schedules from SportyHunter.

**Architecture:**

1. **Find active mirror** — Probes each mirror
2. **Extract events** — Two extraction methods:
   - Standard `<a>` parsing for vs-patterns, watch/live/stream/game/sport links
   - Schedule section parsing: extracts `<div>` elements with schedule/event/match/game CSS classes, then parses `<a>` links within those sections
3. **Resolve event streams** — HTTP fetch → iframe → JavaScript m3u8 patterns → Playwright fallback
4. **Limits** — Up to 25 events per run
5. **Deduplication** — By URL

---

### 6.9 `vipboxScraper.ts`

**Location:** `scripts/commands/playlist/vipboxScraper.ts` (155 lines)

**Group title:** `"! Sports - VIPRow - {Sport}"`

**Base URL:** `https://www.viprow.nu`

Scrapes niche sports events (tennis, rugby, motorsports, volleyball, other) from VIPBox/VIPRow aggregator.

**Architecture:**

1. **Build sport URLs** — Constructs URLs like `https://www.viprow.nu/{sport}` for tennis, rugby, motorsports, volleyball, and "other"
2. **Fetch event page** — HTTP GET each sport page, parse HTML for event links with unix timestamps in `<span class='dt TIMESTAMP'>` elements
3. **Resolve stream URLs** — For each event link:
   - Follows the link to the event page
   - Extracts the embed iframe URL (pointing to third-party players like `dungatv.xyz`, `vipboxi.net`, etc.)
   - Uses `extractM3u8FromEmbed()` with Playwright to intercept m3u8/mpd URLs
4. **Limits** — Max 15 streams per sport (75 total) to bound runtime
5. **Deduplication** — By URL
6. **Focus** — Niche sports not already covered by the 7 existing scrapers (DaddyLive, Streamed, NTV, SportsBite, PPV.TO, Roxie, SportyHunter)

---

### 6.10 `sportsurgeScraper.ts`

**Location:** `scripts/commands/playlist/sportsurgeScraper.ts`

**Group title:** `"! Sports - Sportsurge - {Sport}"`

**Mirrors:** `sportsurge.net`, `sportsurge.club`, `sportsurge.name`

Scrapes live sports event streams from Sportsurge.

**Architecture:**

1. **Find active mirror** — Probes each mirror URL until one responds
2. **Fetch event page** — HTTP GET the homepage, parses HTML for event links with sport categories (NBA, NFL, MLB, NHL, UFC, Soccer, etc.)
3. **Resolve stream URLs** — For each event link:
   - Uses Playwright headless browser to navigate to the event page
   - Intercepts network requests for `.m3u8` and `.mpd` URLs
   - Falls back to DOM inspection for video/iframe sources
4. **Deduplication** — By URL

---

### 6.11 `streamEastScraper.ts`

**Location:** `scripts/commands/playlist/streamEastScraper.ts`

**Group title:** `"! Sports - StreamEast - {Sport}"`

**Mirrors:** `thestreameast.lol`, `streameast.app`, `streameast.xyz`

Scrapes live sports streams from StreamEast.

**Architecture:**

1. **Find active mirror** — Probes each mirror URL
2. **Fetch event page** — HTTP GET homepage, parses HTML for event links grouped by sport
3. **Resolve stream URLs** — For each event:
   - Playwright headless browser navigates to the event page
   - Intercepts network traffic for m3u8/mpd URLs
   - DOM inspection fallback for video/iframe sources
4. **Deduplication** — By URL

---

### 6.12 `liveTvScraper.ts`

**Location:** `scripts/commands/playlist/liveTvScraper.ts`

**Group title:** `"! Sports - LiveTV - {Sport}"`

**Base URL:** `https://livetv.sx/enx/`

Scrapes live sports events from LiveTV aggregator.

**Architecture:**

1. **Build sport URLs** — Constructs URLs for 24 sport keywords (e.g., `nba`, `nfl`, `mlb`, `nhl`, `ufc`, `soccer`, `tennis`, `boxing`, etc.)
2. **Fetch event pages** — HTTP GET each sport page, parse HTML for event listings with teams, start times, and stream links
3. **Resolve stream URLs** — For each event:
   - Follows the event link
   - Extracts embed iframe URLs pointing to third-party players
   - Uses `extractM3u8FromEmbed()` with Playwright to intercept m3u8/mpd URLs
4. **Limits** — Processes events from each sport page with `eachLimit` concurrency of 5
5. **Deduplication** — By URL

---

### 6.13 `portalScraper.ts`

**Location:** `scripts/commands/playlist/portalScraper.ts`

**Group title:** `"! Portals - {domain}"` (e.g., `! Portals - cord-cutter.net:8080`)

**Base source:** GitHub XML2 dumps (configurable repos) + Reddit RSS

Scrapes live streams from Xtream-Codes IPTV portals. This is the most sophisticated scraper in the codebase, handling encryption, multi-protocol verification, and intelligent deduplication.

**Architecture:**

1. **Portal Discovery** — Fetches portal URLs from two sources:
   - **GitHub XML2 dumps** — Reads `.txt` files from configurable repos (`GITHUB_PORTAL_REPOS`), each line being a `username:password@host:port` or full URL. Lines may be plaintext or OpenSSL-encrypted (v1/v2/v3 paste.sh encryption).
   - **Reddit RSS** — Fetches up to 5 pages of r/XML2 posts via Reddit's public JSON API (with CORS proxy fallback), extracts code blocks containing portal credentials.

2. **Paste Decryption** — Paste.sh encrypted lines go through a 3-tier decryption cascade:
   - **PBKDF2-HMAC-SHA512** (v2/v3): `DK = HMAC-SHA512(password, salt || 0x00000001)`, key=first 32 bytes, IV=next 16 bytes, AES-256-CBC. Password = `id + serverkey + clientKey + 'https://paste.sh'`
   - **EVP_BytesToKey** (v1 fallback): SHA-512(password + salt) with count=1
   - **Hex-based fallback**: Direct hex decoding for non-OpenSSL formats

3. **Portal Verification** — Each discovered portal is verified via `verifyPortal()`:
   - Attempts `player_api.php?action=user&username=...&password=...` — Xtream JSON API
   - Falls back to `get.php?username=...&password=...&type=m3u_plus` — M3U playlist
   - Rejects portals returning: XUI.one debug pages, `<html>` responses, `Debug Mode` text, M3U with <5 real streams, English text <70% (non-Latin script filter)
   - **Adult filter**: Also samples first 30 EXTINF lines against adult keywords; skips if ≥30% match

4. **Stream Fetching** — `fetchPortalStreams()` in dual mode:
   - **Xtream API** (`get_live_categories` → `get_live_streams`): JSON response with HD/stream_id/stream_icon/category_id. Fetches categories first, then streams per category (up to `MAX_STREAMS_PER_PORTAL`).
   - **M3U fallback** (`get.php`): Parses raw M3U with tvg-id, tvg-logo, channel names via regex.
   - Both modes apply: **adult category pre-filter** (if ≥30% of categories are adult, skip entirely), **adult stream name filter** (per-stream keyword check), **non-Latin script filter** (removes Arabic, Cyrillic, CJK, etc.)

5. **Sports Filtering** — `isPortalSportsStream()` matches stream names against 90+ keywords in 3 categories:
   - **Sports** (nfl, nba, mlb, nhl, ufc, boxing, soccer, tennis, etc.)
   - **PPV** (ppv, pay-per-view, event, fight, wrestling, wwe, etc.)
   - **Live Events** (live, 24/7, 24x7, news, etc. — excludes music, cartoon, movie-only channels)
   Only streams matching these keywords are returned.

6. **Deduplication & Grouping** — Intelligent merging across portals:
   - **Domain-based grouping**: Portals grouped by `extractDomain()` — e.g., 13 users on `cord-cutter.net:8080` merged into one group
   - **Jaccard similarity dedup**: Compares first 25 channel titles per portal. Portals with >70% identical names are duplicates — keeps the one with most streams
   - **Cross-portal URL dedup**: Within a domain group, duplicate stream URLs are eliminated
   - **Duplicate stream numbering**: Duplicate titles get `str N - ` prefix (e.g., `str 2 - ESPN`)

7. **Time Filtering** — `isRecentStream()`: drops events >6 hours past or >24 hours in the future

**Key Features:**
- Circuit breaker per CORS proxy — 45s cooldown on failure, 90s on 429
- Domain-level adult filter (`ADULT_DOMAIN_PATTERNS`) — skips portals with xxx/adult/porn in domain
- Configurable env vars: `VERIFY_TIMEOUT`, `FETCH_TIMEOUT`, `MAX_VERIFIED_PORTALS`, `MAX_STREAMS_PER_PORTAL`
- Portal health report: saves stats per portal (status, stream count, domain group)

---

### 6.14 `dlhdScraper.ts`

**Location:** `scripts/commands/playlist/dlhdScraper.ts`

**Group title:** `"! Sports - DLHD - {sport}"`

**Base URL:** `https://dlhd.st/`

Scrapes live sports streams from DLHD sports aggregator.

**Architecture:**

1. **Mirror resolution** — `findActiveMirror(MIRRORS)` checks each mirror domain with HTTP GET; uses the first responsive one (default: `dlhd.st`)
2. **Sport page fetching** — HTTP GET for each sport (nfl, nba, mlb, nhl, ufc, soccer, boxing, wrestling, tennis, f1, mlr, ncaaf, ncaam, golf, nll, afl, cricket, rugby, darts, snooker, cyclying, motors, nba g-league)
3. **Stream URL extraction** — Regex parses event links from sport page HTML
4. **Per-event scraping** — For each event link, fetches page and extracts m3u8 streams via regex (`https?://[^"']+\.m3u8[^"']*`)
5. **404 filtering** — Checks each m3u8 URL with HTTP HEAD before adding
6. **Stream creation** — Uses `createStream()` with group-title `"! Sports - DLHD - {sport}"`, tvg-logo from OG image
7. **Limits** — Max 25 stream resolves per scrape run

---

### 6.15 `rabbitMeowScraper.ts`

**Location:** `scripts/commands/playlist/rabbitMeowScraper.ts`

**Group title:** `"! Sports - RabbitMeow - {sport}"`

**Base URL:** `https://rabbitmeow.live/`

Scrapes live sports streams from RabbitMeow SPA (Single Page Application).

**Architecture:**

1. **Browser launch** — Uses Playwright Chromium with page blocking (images, fonts) for speed
2. **Mirror resolution** — `findActiveMirror(MIRRORS)` with 3 mirror domains
3. **Navigation** — Loads homepage, waits for `.category-card` elements to appear, extracts sport categories
4. **SPA interaction** — Clicks each sport category, waits for stream cards to render
5. **Stream extraction** — From each stream page, intercepts network requests to capture `playlist.m3u8` URLs using `page.on('request')`
6. **iframe resolution** — Some streams open in iframes; uses `extractM3u8FromEmbed()` for those
7. **Limits** — Max 20 stream resolves per scraper run

---

### 6.16 `theTvAppScraper.ts`

**Location:** `scripts/commands/playlist/theTvAppScraper.ts`

**Group title:** `"! Sports - TheTVApp - {sport}"`

**Base URL:** `https://thetvappv2.com/`

Scrapes live TV sports channels from TheTVApp aggregator.

**Architecture:**

1. **Mirror resolution** — `findActiveMirror(MIRRORS)` with 2 mirror domains
2. **Category pages** — HTTP GET for 11 sport category pages (Sports, NFL, NBA, MLB, NHL, NCAAF, NCAAB, Soccer, Boxing, MMA/UFC, Rugby)
3. **HTML parsing** — Regex extracts channel entries from each category page (channel name, iframe embed URL)
4. **Embed extraction** — For each channel, fetches the embed page and extracts m3u8 URL via regex and `extractM3u8FromEmbed()`
5. **Stream creation** — Uses `createStream()` with descriptive group-title
6. **Limits** — Max 25 stream resolves per scrape run

---

### 6.17 `totalSportekScraper.ts`

**Location:** `scripts/commands/playlist/totalSportekScraper.ts`

**Group title:** `"! Sports - TotalSportek - {sport}"`

**Base URL:** `https://totalsporteka.com/`

Scrapes live sports events from TotalSportek SPA.

**Architecture:**

1. **Browser launch** — Uses Playwright Chromium with resource blocking
2. **Mirror resolution** — `findActiveMirror(MIRRORS)` with 3 mirror domains (totalsporteka.com, totalsportek.to, totalsportek.pro)
3. **Navigation** — Loads homepage, waits for sport category links to render
4. **Category extraction** — Extracts sport categories from navigation links
5. **Event listing** — For each sport category, waits for event cards to appear, extracts event links
6. **Stream resolution** — For each event, clicks the stream link, waits for iframe or video element, intercepts m3u8 network requests
7. **Limits** — Max 20 stream resolves per scrape run

---

## 7. Project File Structure

```
iptv/
├── .github/workflows/
│   ├── ultimate.yml          # Daily UltimateTV playlist + EPG
│   ├── merge-all.yml         # Every 3 days: merge all streams
│   ├── check.yml             # PR validation (lint + validate)
│   ├── health-check.yml      # Every 60 min: remove dead streams
│   ├── stream-check.yml      # Manual: validate stream URLs
│   ├── scrape-sports.yml     # Manual: scrape live sports by user input
├── .readme/
├── .readme/
│   ├── template.md           # Template for PLAYLISTS.md
│   ├── preview.png           # README preview image
│   └── config.json           # Markdown-include config
├── scripts/
│   ├── api.ts                # Core data loading + channel/stream/guide APIs
│   ├── constants.ts          # Path constants (ROOT_DIR, STREAMS_DIR, DATA_DIR, etc.)
│   ├── utils.ts              # URL validation, stream info, issue/discussion loading
│   ├── commands/
│   │   ├── api/load.ts       # Downloads latest iptv-org API data
│   │   ├── playlist/
│   │   │   ├── generateUltimate.ts  # UltimateTV playlist + built-in EPG
│   │   │   ├── mergeAllM3u.ts       # Merge all streams/ into one playlist
│   │   │   ├── quickHealthCheck.ts  # HTTP-only health check (no mediainfo)
│   │   │   ├── reorg.ts             # Standalone playlist reorganization
│   │   │   ├── generateEpg.ts       # EPG channels XML + guide processing
│   │   │   ├── generate.ts          # Full public playlist generation
│   │   │   ├── format.ts            # URL normalization, dedup, sort
│   │   │   ├── update.ts            # Process GitHub issue-based updates
│   │   │   ├── validate.ts          # Validate tvg-ids, URLs, blocklists
│   │   │   ├── test.ts              # Test stream availability
│   │   │   ├── edit.ts              # Interactive channel mapping
│   │   │   ├── export.ts            # Export streams to JSON
│   │   │   ├── daddyliveScraper.ts  # DaddyLive sports scraper
│   │   │   ├── daddyliveScraper.ts  # DaddyLive sports scraper
│   │   │   ├── streamedScraper.ts   # Streamed.pk sports scraper
│   │   │   ├── ntvScraper.ts        # NTV (ntvs.cx) live sports scraper
│   │   │   ├── sportsBiteScraper.ts # SportsBite event scraper
│   │   │   ├── ppvToScraper.ts      # PPV.TO scraper
   │   │   │   ├── roxieScraper.ts      # RoxieStreams scraper
   │   │   │   ├── sportyHunterScraper.ts # SportyHunter scraper
    │   │   │   └── vipboxScraper.ts     # VIPRow/VIPBox niche sports scraper
    │   │   │   ├── sportsurgeScraper.ts  # Sportsurge scraper
│   │   │   ├── streamEastScraper.ts  # StreamEast scraper
│   │   │   ├── liveTvScraper.ts      # LiveTV scraper
│   │   │   ├── scrapeSports.ts       # User-driven sports scrape command
│   │   │   ├── portalScraper.ts      # Xtream-Codes portal scraper
│   │   │   ├── dlhdScraper.ts        # DLHD sports streams (HTTP)
│   │   │   ├── rabbitMeowScraper.ts  # RabbitMeow SPA sports (Playwright)
│   │   │   ├── theTvAppScraper.ts    # TheTVAppv2 channels (HTTP)
│   │   │   └── totalSportekScraper.ts # TotalSportek SPA (Playwright)
│   │   ├── readme/update.ts  # Update PLAYLISTS.md with stats
│   │   └── report/create.ts  # Create issue/discussion reports
│   ├── core/
│   │   ├── index.ts          # Re-exports
│   │   ├── cliTable.ts       # CLI table rendering
│   │   ├── htmlTable.ts      # HTML table rendering
│   │   ├── dataSet.ts        # Issue body YAML extraction
│   │   ├── logParser.ts      # Log parsing
│   │   ├── markdown.ts       # Markdown compilation
│   │   ├── numberParser.ts   # Number parsing
│   │   ├── playlistParser.ts # M3U parsing (wraps iptv-playlist-parser)
│   │   ├── proxyParser.ts    # Proxy URL parsing
│   │   ├── streamTester.ts   # Stream link testing (axios + mediainfo.js)
│   │   └── aggregatorHelpers.ts # Shared: getBrowser, extractM3u8FromEmbed, createStream, fetchWithTimeout
│   ├── generators/
│   │   ├── generator.ts / index.ts
│   │   ├── rawGenerator.ts, categoriesGenerator.ts
│   │   ├── languagesGenerator.ts, countriesGenerator.ts
│   │   ├── subdivisionsGenerator.ts, citiesGenerator.ts
│   │   ├── regionsGenerator.ts, sourcesGenerator.ts
│   │   └── index*.ts (index, indexCategory, indexCountry, indexLanguage)
│   ├── models/
│   │   ├── index.ts
│   │   ├── stream.ts         # Stream model extends SDK
│   │   ├── playlist.ts       # Playlist model with M3U generation
│   │   ├── issue.ts          # GitHub issue model
│   │   └── discussion.ts     # GitHub discussion model
│   └── tables/
│       ├── categoriesTable.ts, countriesTable.ts
│       ├── languagesTable.ts, regionsTable.ts
│       └── table.ts
├── streams/                  # 325 M3U files organized into subdirectories
│   ├── countries/            # 200 base per-country files (e.g., us.m3u, fr.m3u)
│   ├── sources/              # 123 source-specific files (e.g., us_pluto.m3u, fr_samsung.m3u)
│   ├── vod/                  # VOD playlists (movies.m3u, tv-shows.m3u)
│   └── generated/            # 2 auto-generated files (e.g., us_famelack.m3u)
│   └── ...
├── tests/
│   ├── commands/playlist/
│   │   ├── edit.test.ts, export.test.ts, format.test.ts
│   │   ├── generate.test.ts, test.test.ts, update.test.ts
│   │   └── validate.test.ts
│   ├── commands/readme/update.test.ts
│   ├── commands/report/create.test.ts
│   └── __data__/             # Test fixtures (input/ + expected/)
├── Debrify/                  # Empty (reserved)
├── temp/                     # Temporary data/logs (gitignored)
├── package.json
├── tsconfig.json
├── eslint.config.mjs
├── .prettierrc
├── .gitignore
├── m3u-linter.json
├── README.md
├── PLAYLISTS.md
├── CONTRIBUTING.md
├── FAQ.md
├── IPTV_VERSION.md           # This file
└── LICENSE
```

---

## 8. Script Reference

| npm Command | Script | Description |
|-------------|--------|-------------|
| `npm run api:load` | `scripts/commands/api/load.ts` | Download latest channel/stream/guide data from iptv-org |
| `npm run playlist:ultimate` | `scripts/commands/playlist/generateUltimate.ts` | Generate UltimateTV playlist + built-in EPG |
| `npm run playlist:mergeAll` | `scripts/commands/playlist/mergeAllM3u.ts` | Merge all streams/ files into one playlist |
| `npm run playlist:epg` | `scripts/commands/playlist/generateEpg.ts` | EPG channel XML generation or guide processing |
| `npm run playlist:generate` | `scripts/commands/playlist/generate.ts` | Generate all public playlists (categories, languages, etc.) |
| `npm run playlist:format` | `scripts/commands/playlist/format.ts` | Normalize URLs, remove duplicates, detect quality, sort |
| `npm run playlist:update` | `scripts/commands/playlist/update.ts` | Process GitHub issue-based stream additions/edits/removals |
| `npm run playlist:validate` | `scripts/commands/playlist/validate.ts` | Validate tvg-ids, URLs, check blocklists |
| `npm run playlist:lint` | `m3u-linter -c m3u-linter.json` | M3U syntax linting |
| `npm run playlist:test` | `scripts/commands/playlist/test.ts` | Test stream link availability |
| `npm run playlist:edit` | `scripts/commands/playlist/edit.ts` | Interactive channel-to-stream mapping |
| `npm run playlist:export` | `scripts/commands/playlist/export.ts` | Export streams to JSON for iptv-org/api |
| `npm run playlist:sports` | `scripts/commands/playlist/scrapeSports.ts` | Scrape live sports by user-specified sport (NFL, NBA, all, etc.) |
| `npm run playlist:sync` | `scripts/commands/playlist/syncStreams.ts` | Sync latest M3U files from iptv-org/iptv upstream |
| `npm run readme:update` | `scripts/commands/readme/update.ts` | Update PLAYLISTS.md with current stats |
| `npm run report:create` | `scripts/commands/report/create.ts` | Generate issue/discussion report |
| `npm run lint` | eslint `scripts/` `tests/` | Lint TypeScript files |
| `npm test` | jest --runInBand | Run all tests |

---

## 9. Dependencies

### Runtime
| Package | Version | Purpose |
|---------|---------|---------|
| `@freearhey/core` | ^0.14.3 | Collections, Logger, Timer, Templates |
| `@freearhey/storage-js` | ^0.1.0 | File storage with glob support |
| `@iptv-org/sdk` | ^1.5.0 | IPTV data models (channels, streams, guides) |
| `axiox` | ^1.15.2 | HTTP client for API calls and downloads |
| `playwright` | ^1.61.1 | Headless Chromium for sports scraper |
| `iptv-playlist-parser` | ^0.15.1 | M3U playlist parsing |
| `commander` | ^14.0.0 | CLI argument parsing |
| `@inquirer/prompts` | ^7.8.0 | Interactive CLI prompts |
| `tsx` | ^4.20.3 | TypeScript execution |
| `chalk` | ^5.4.1 | Terminal colors |
| `cli-progress` | ^3.12.0 | CLI progress bars |
| `console-table-printer` | ^2.14.6 | Pretty CLI tables |
| `mediainfo.js` | ^0.3.6 | Stream media analysis |
| `hls-parser` | ^0.16.0 | HLS playlist parsing (resolution detection) |
| `mpd-parser` | ^1.3.1 | DASH manifest parsing |
| `socks-proxy-agent` | ^8.0.5 | SOCKS proxy support |
| `normalize-url` | ^8.1.0 | URL normalization |
| `m3u-linter` | ^0.4.3 | M3U syntax linter |
| `@octokit/*` | various | GitHub API client |
| `es-toolkit` | ^1.45.1 | Utility library |
| `async` | ^3.2.6 | Async utilities (eachLimit) |
| `jest` | ^30.0.5 | Testing framework |

### Infrastructure
- **Node.js:** 22
- **Docker:** `ghcr.io/iptv-org/epg:master` (for EPG scraping)
- **GitHub Actions:** ubuntu-latest runners

---

## 10. Testing

**Framework:** Jest 30 with `@swc/jest` TypeScript transformer

**Test files:** 9 test files covering:
- Playlist editing, exporting, formatting, generating, testing, updating, validating
- README updates
- Report creation

**Test data:** `tests/__data__/` contains input fixtures and expected outputs

**Running tests:**
```bash
npm test                    # All tests (jest --runInBand)
npx jest tests/commands/playlist/validate.test.ts   # Individual test
```

**Environment variables** for testing:
- `STREAMS_DIR`, `DATA_DIR`, `ROOT_DIR`, `PUBLIC_DIR`, `LOGS_DIR`, `API_DIR`
- `NODE_ENV=test` for mock data mode

---

## 11. Recent Improvements

### July 1, 2026 — Configurable Env Vars, Multi-Sport, Tests, Dashboard, Snapshots, .opencode.json (v1.13.0)

**Theme:** *Operational maturity — making the system tunable, observable, testable, and configurable without code changes.*

---

#### 1. Environment Variable Configuration

**Problem:** All timeouts and concurrency limits were hardcoded. Tuning for different environments (local dev vs GitHub Actions vs beefy server) required editing source files. The 5-minute scraper timeout that works on a fast machine might be too aggressive on a slow runner, and the 50-concurrent-stream check might overwhelm a metered connection.

**Solution:** Every tunable constant now reads from an environment variable first, falling back to its hardcoded default:

| Env Var | Files | Default | Purpose |
|---------|-------|---------|---------|
| `SCRAPER_TIMEOUT` | scrapeSports.ts, generateUltimate.ts | 300000 (5 min) | Max time per scraper before it's killed |
| `GLOBAL_TIMEOUT` | generateUltimate.ts | 3300000 (55 min) | Total timeout for the entire playlist generation |
| `CHECK_TIMEOUT` | scrapeSports.ts, generateUltimate.ts, quickHealthCheck.ts | 10000 (10s) | Timeout for each individual stream HTTP check |
| `CHECK_CONCURRENCY` | scrapeSports.ts, generateUltimate.ts | 50 | How many streams to check simultaneously |
| `VERIFY_TIMEOUT` | portalScraper.ts | 8000 (8s) | Timeout for portal API verification calls |
| `FETCH_TIMEOUT` | portalScraper.ts | 15000 (15s) | Timeout for fetching portal stream lists |
| `MAX_VERIFIED_PORTALS` | portalScraper.ts | 20 | Max verified portals to keep per scrape run |
| `MAX_STREAMS_PER_PORTAL` | portalScraper.ts | 500 | Max streams to pull from a single portal |

**Usage:** `SCRAPER_TIMEOUT=60000 npm run playlist:sports -- --sport=nfl` — overrides scraper timeout to 60s for this run only.

**Pattern used:** `parseInt(process.env.VAR_NAME || '') || DEFAULT_VALUE` — this ensures that:
- If the env var is not set (`undefined`), the default is used
- If the env var is set to an empty string, the default is used
- If the env var is set to a valid number, that value is used
- No `NaN` propagation (a typo like `export CHECK_TIMEOUT=abc` falls back safely)

---

#### 2. Multi-Sport Scraping

**Problem:** The `--sport` flag accepted only a single value. To scrape both NFL and NBA streams, you'd need two separate runs. Since scrapers take 5 minutes each, this doubled runtime.

**Solution:** `--sport` now accepts comma-separated values:

```bash
# Before
npm run playlist:sports -- --sport=nfl    # One run for NFL
npm run playlist:sports -- --sport=nba    # Second run for NBA

# After
npm run playlist:sports -- --sport=nfl,nba    # Single run, both sports
```

**How it works:** The `matchesSport()` function was refactored from a simple string-includes check to an array-based check:

```typescript
// Before: matchesSport(stream, sport: string)
function matchesSport(stream: Stream, sports: string[]): boolean {
  if (sports.length === 1 && sports[0] === 'all') return true
  const title = (stream.title || '').toLowerCase()
  const group = (stream.groupTitle || '').toLowerCase()
  return sports.some(s => title.includes(s.toLowerCase()) || group.includes(s.toLowerCase()))
}
```

Each stream's title and group-title are checked against every sport in the list. If any match, the stream is kept. The `all` shortcut is preserved as a special case.

**Data flow:**
1. `parseArg('sport', 'all')` returns the raw string (e.g. `"nfl,nba"`)
2. `.split(',').map(s => s.trim()).filter(Boolean)` produces `["nfl", "nba"]`
3. The array is passed to `matchesSport()` and used in log messages via `sports.join(', ')`

---

#### 3. Scraper Health Dashboard

**Problem:** When scrapers fail (timeout, site changed, domain dead), there was no record of which scraper failed, how many streams it produced before failing, or how the overall health changed over time. You'd only know something was wrong when sports streams went missing from the playlist.

**Solution:** After each scrape run, a JSON report is saved to `streams/scraper-report.json`:

```json
{
  "date": "2026-07-01T12:00:00.000Z",
  "sport": "nfl,nba",
  "scrapers": [
    {
      "name": "DaddyLive",
      "status": "fulfilled",
      "streams": 45
    },
    {
      "name": "StreamEast",
      "status": "rejected",
      "streams": 0
    }
  ],
  "totalScraped": 187,
  "aliveAfterCheck": 142,
  "existingKept": 3521,
  "totalWritten": 3663
}
```

**Dashboard fields:**
- `date` — ISO timestamp of the run
- `sport` — The sport filter used (preserves comma-separated values)
- `scrapers[]` — Per-scraper breakdown with status (`fulfilled`/`rejected`) and raw stream count before health check
- `totalScraped` — Raw count of streams extracted from all scrapers (before health check)
- `aliveAfterCheck` — Streams that passed the HTTP reachability check
- `existingKept` — Streams already in the playlist that were preserved
- `totalWritten` — Final playlist size

**How to monitor:** Commit and push this file alongside the playlist. Over time, you can track:
- Which scrapers are consistently failing (site may have changed or gone offline)
- Which scrapers produce the most streams (roi per scraper)
- Whether the health check is removing too many or too few streams
- The ratio of scraped-to-kept streams (a sudden drop indicates a site change)

---

#### 4. Health Check Snapshots (Stream Archive)

**Problem:** The hourly health check removes dead streams silently. If a stream goes down briefly (transient network issue, server restart), it gets removed and has to be re-added on the next full playlist generation (up to 24 hours later). There was no historical record of which streams were removed or how stream health changes over time.

**Solution:** Each health check run now appends a snapshot to a daily JSON file in `streams/health-snapshots/`:

```json
[
  {
    "timestamp": "2026-07-01T12:00:00.000Z",
    "checked": 4521,
    "working": 4403,
    "errors": 89,
    "warnings": 29,
    "totalStreams": 4521
  },
  {
    "timestamp": "2026-07-01T13:00:00.000Z",
    "checked": 4512,
    "working": 4401,
    "errors": 82,
    "warnings": 29,
    "totalStreams": 4512
  }
]
```

**Archive mechanics:**
- One file per day: `streams/health-snapshots/health-2026-07-01.json`
- Each run appends a new entry (not overwrite)
- Maximum 30 entries per file (last 30 runs — at 1/hour, that's ~30 hours of history)
- Older entries are automatically trimmed

**What you can learn from snapshots:**
- Sudden spike in errors → possible network issue or upstream source went offline
- Steady decline in working streams → sources are dying and need replacement
- Recovery patterns after playlist regeneration (full gen usually restores many "dead" streams)
- Which days/times have the highest error rates (could indicate traffic patterns or maintenance windows)

---

#### 5. Opencode Configuration (`.opencode.json`)

**Problem:** The project had an `AGENTS.md` with minimal instructions but no structured configuration for AI tooling. Each session started cold — no custom commands, no agent specializations.

**Solution:** Created `.opencode.json` with:

**Custom commands** — shortcuts for common operations:
```json
{
  "name": "scrape-sports",
  "command": "npm run playlist:sports -- --sport={{sport}}",
  "description": "Scrape live sports streams (e.g. nfl, nba, ufc, or comma-separated: nfl,nba)"
}
```
Available commands: `scrape-sports`, `sync-streams`, `generate-ultimate`, `health-check`, `run-tests`, `lint`.

**Scraper-dev agent** — a specialized agent with deep knowledge of the scraping patterns used in this project:
```json
{
  "agents": {
    "scraper-dev": {
      "description": "Specialist for developing and fixing sports scrapers",
      "instructions": "1) Use the shared browser from aggregatorHelpers.ts via getBrowser()/closeBrowser() 2) Follow the mirror pattern (findActiveMirror, MIRRORS array) 3) Use createStream() factory..."
    }
  }
}
```

**Permissions** — scoped filesystem access to prevent accidental writes outside the project:
```json
{
  "permissions": {
    "allow_fs_write_paths": [".", "streams", "Robbdeeze_UltimateTV.m3u"]
  }
}
```

---

#### 6. Scraper Unit Tests

**Problem:** The 11 sports scrapers and portal scraper had zero tests. The shared utility functions in `aggregatorHelpers.ts` (used by every scraper) had no test coverage. Bugs in `extractTimeFromText` or `createStream` would silently corrupt stream data across all 11 scrapers.

**Solution:** Created `tests/core/aggregatorHelpers.test.ts` with **14 tests** across 3 describe blocks:

**`extractTimeFromText`** (4 tests):
- `"Game starts at 8:00 PM ET"` → extracts `"8:00 PM"`
- `"Match at 10:30 AM"` → extracts `"10:30 AM"`
- `"Event at 14:30"` → extracts `"14:30"` (24h, no am/pm)
- `"No time here"` → returns `null`

**`isWithin24hrsPT`** (6 tests):
- 1 hour ago → `true`
- 12 hours from now → `true`
- 48 hours ago → `false`
- 48 hours from now → `false`
- Exactly 24 hours ago → `true` (boundary)
- Exactly 24 hours from now → `true` (boundary)

**`createStream`** (4 tests):
- Correctly sets title, url, groupTitle
- Sets tvgId when provided
- Defaults tvgId to title when not provided
- Preserves the "Sports - Live / PPV / Events" group-title

**Test infrastructure change:** Added `transformIgnorePatterns` to the Jest config to allow transforming `@freearhey/core` and `@iptv-org/*` packages through SWC. Previously, only direct project code was transformed; these ESM dependencies would cause `unexpected token` errors. The pattern:
```json
"transformIgnorePatterns": ["/node_modules/(?!(@freearhey|@iptv-org)/)"]
```
This tells Jest: "ignore all node_modules EXCEPT @freearhey and @iptv-org packages" — the `?!` is a negative lookahead in regex.

---

#### 7. 4 New Sports Scrapers (DLHD, RabbitMeow, TheTVApp, TotalSportek)

**Problem:** Only 12 scrapers covered mainstream sports sites. Niche sports, 24/7 sports channels, and sites with different architectures (SPA vs server-rendered) were missed. Users reported streams going dark when specific sites changed their layout.

**Solution:** Added 4 new scrapers targeting different site architectures and content types:

**DLHD** (`dlhdScraper.ts`) — Server-rendered HTML site with 23+ sport categories (including niche: MLR, NLL, AFL, cricket, rugby, darts, snooker, cycling, motors, NBA G-League). Uses `findActiveMirror` pattern with 2 mirrors, HTTP GET + regex for event extraction, and HTTP HEAD pre-check for m3u8 validity before adding streams. Max 25 stream resolves.

**RabbitMeow** (`rabbitMeowScraper.ts`) — SPA site rendered client-side via JavaScript. Uses Playwright Chromium with resource blocking (images/fonts for speed). Extracts sport categories from `.category-card` elements, clicks each category, intercepts network requests to capture `playlist.m3u8` URLs. Falls back to `extractM3u8FromEmbed()` for iframe-based streams. Max 20 stream resolves.

**TheTVApp** (`theTvAppScraper.ts`) — Server-rendered TV channel aggregator with 11 sport category pages (including 24/7 sports news channels). Uses HTTP GET + regex for channel/embed URL extraction. Resolves m3u8 from embed pages via regex and `extractM3u8FromEmbed()`. Good source for always-on sports channels. Max 25 stream resolves.

**TotalSportek** (`totalSportekScraper.ts`) — SPA event aggregator covering major sports (NFL, NBA, MLB, NHL, UFC, soccer, boxing, etc.). Uses Playwright Chromium with 3 mirror domains. Extracts sport categories from navigation, clicks each to reveal event cards, then resolves m3u8 via network interception. Max 20 stream resolves.

**Integration:**
- All 4 scrapers imported into `scrapeSports.ts` (sports scrape command) and `generateUltimate.ts` (full pipeline)
- Each follows the mirror pattern (`MIRRORS` array + `findActiveMirror()`)
- Each uses `createStream()` from `aggregatorHelpers.ts` for uniform Stream object creation
- Each sets descriptive group-title: `"! Sports - {ScraperName} - {sport}"`
- All integrated with existing health-check, dedup, and time-filtering pipeline
- All respect the 24-hour event window via `isRecentStream()`
- Pipeline now runs 16 scrapers in parallel instead of 12

**Scraper patterns used:**

| Pattern | Scrapers | Why |
|---------|----------|-----|
| Server-rendered HTML | DLHD, TheTVApp | HTTP GET + regex is faster, lighter, no browser needed |
| SPA / Client-rendered | RabbitMeow, TotalSportek | Playwright needed for JS-rendered content |
| Mirror fallback | All 4 | `findActiveMirror()` ensures resilience if primary domain changes |
| Network interception | RabbitMeow, TotalSportek | Captures m3u8 URLs from browser network traffic |
| Time filtering | All 4 | `isRecentStream()` ensures only current/recent events appear |
| Stream cap | All 4 | 20-25 max resolves per scraper keeps runtime bounded |

---

| Change | File | Description |
|--------|------|-------------|
| Configurable timeouts via env vars | `scripts/commands/playlist/scrapeSports.ts` | SCRAPER_TIMEOUT, CHECK_TIMEOUT, CHECK_CONCURRENCY now read from environment variables with fallback to hardcoded defaults |
| Configurable timeouts via env vars | `scripts/commands/playlist/generateUltimate.ts` | SCRAPER_TIMEOUT, GLOBAL_TIMEOUT, CHECK_TIMEOUT, CHECK_CONCURRENCY now read from env vars |
| Configurable timeouts via env vars | `scripts/commands/playlist/quickHealthCheck.ts` | CHECK_TIMEOUT now read from env var |
| Configurable timeouts via env vars | `scripts/commands/playlist/portalScraper.ts` | VERIFY_TIMEOUT, FETCH_TIMEOUT, MAX_VERIFIED_PORTALS, MAX_STREAMS_PER_PORTAL now read from env vars |
| Multi-sport scraping | `scripts/commands/playlist/scrapeSports.ts` | `--sport` now accepts comma-separated values (e.g. `--sport=nfl,nba,ufc`) to scrape multiple sports at once |
| Scraper unit tests | `tests/core/aggregatorHelpers.test.ts` | 14 tests covering extractTimeFromText, isWithin24hrsPT, createStream — all pure functions used by every scraper |
| Transform ignore patterns for Jest | `package.json` | Added transformIgnorePatterns to correctly handle @freearhey and @iptv-org ESM packages |
| Scraper health dashboard | `scripts/commands/playlist/scrapeSports.ts` | Saves `streams/scraper-report.json` after each scrape with per-scraper status, stream counts, alive/dead breakdown |
| Health check snapshots | `scripts/commands/playlist/quickHealthCheck.ts` | Saves daily health snapshots to `streams/health-snapshots/health-YYYY-MM-DD.json` (keeps last 30 days) |
| Opencode configuration | `.opencode.json` | Custom commands (scrape-sports, sync-streams, etc.) and scraper-dev agent with instructions |
| Version bump | `IPTV_VERSION.md` | Updated to 1.13.0 |

### July 1, 2026 — Scrape Sports Workflow + Portal Sports Filter (v1.12.0)

| Change | File | Description |
|--------|------|-------------|
| User-driven sports scrape command | `scripts/commands/playlist/scrapeSports.ts` | New command — accepts `--sport` arg (NFL, NBA, Soccer, all, etc.), runs all 15 sports scrapers + portals in parallel with 5-min timeouts, filters by sport keyword, health-checks streams, updates `Robbdeeze_UltimateTV.m3u` |
| Portal scraper: sports/PPV/live events only | `scripts/commands/playlist/scrapeSports.ts` | Portal streams filtered through `isPortalSportsStream()` — 90+ keyword filter (sport, espn, nfl, ppv, live event, etc.) before user sport filter is applied |
| All scraped streams in one category | `scripts/commands/playlist/scrapeSports.ts` | All scraped streams set to group-title `"Sports - Live / PPV / Events"` |
| No old-entry stripping | `scripts/commands/playlist/scrapeSports.ts` | New streams merge with existing via URL dedup only |
| GitHub Actions workflow | `.github/workflows/scrape-sports.yml` | New `workflow_dispatch` workflow — user enters sport via input, installs deps + Playwright, runs scraper, commits changes |
| npm script | `package.json` | Added `playlist:sports` command |
| Version bump | `IPTV_VERSION.md` | Updated to 1.12.0 |
| Health check workflow fix | `scripts/commands/playlist/quickHealthCheck.ts` | Exits with code 0 after successful `--fix` so the commit step runs — was exiting 1 even after removing dead streams, causing workflow failure |
| Upstream stream sync command | `scripts/commands/playlist/syncStreams.ts` | New command — fetches latest M3U files from iptv-org/iptv's `streams/` and routes country files to `streams/countries/` and source files to `streams/sources/` |
| External playlist sync | `scripts/commands/playlist/syncStreams.ts` | Also fetches YueChan (Global + Radio), DrewLive merged playlist into `streams/external/` and Famelack US/UK data into `streams/generated/` |
| npm script | `package.json` | Added `playlist:sync` command |

### July 1, 2026 — paste.sh Decryption Fix: PBKDF2-HMAC-SHA512 + Serverkey (v1.11.0)

| Change | File | Description |
|--------|------|-------------|
| Correct paste.sh KDF for v2/v3 pastes | `scripts/commands/playlist/portalScraper.ts` | v2/v3 pastes use **PBKDF2-HMAC-SHA512** (`OpenSSLPbkdf2`), not EVP_BytesToKey. DK = `HMAC-SHA512(password, salt \|\| 0x00000001)` — key=first 32 bytes, IV=next 16 bytes |
| EVP_BytesToKey v1 fallback | `scripts/commands/playlist/portalScraper.ts` | Legacy pastes still use `SHA-512(password \|\| salt)` with count=1 — tried second after PBKDF2 |
| Serverkey extracted from first line | `scripts/commands/playlist/portalScraper.ts` | First line of `.txt` response is the serverkey (may be blank or non-blank). Now properly extracted and included in password: `id + serverkey + clientKey + 'https://paste.sh'` |
| Hex-based fallback preserved | `scripts/commands/playlist/portalScraper.ts` | Third fallback for non-OpenSSL-format pastes (if any remain) |
| Version bump | `IPTV_VERSION.md` | Updated to 1.11.0 |

### June 30, 2026 — CORS Proxy Circuit Breaker, Reddit Pagination, paste.sh Decryption (v1.10.0)

| Change | File | Description |
|--------|------|-------------|
| corsfix.com proxy | `scripts/commands/playlist/portalScraper.ts` | Added 5th CORS proxy `proxy.corsfix.com` to `CORS_PROXIES` array |
| Circuit breaker per proxy | `scripts/commands/playlist/portalScraper.ts` | Tracks consecutive failures per proxy with 45s cooldown (90s on 429). Skips proxies in cooldown instead of retrying them on every call |
| Reddit pagination | `scripts/commands/playlist/portalScraper.ts` | `fetchRedditPortals()` now fetches up to 5 pages using the `after` cursor instead of just 1 page |
| paste.sh AES decryption | `scripts/commands/playlist/portalScraper.ts` | Replaced `return null` for paste.sh with full `decryptPasteSh()` — PBKDF2-SHA512 with MD5 EVP BytesToKey fallback, AES-256-CBC |
| Version bump | `IPTV_VERSION.md` | Updated to 1.10.0 |

### June 30, 2026 — Portal Organization: Domain Grouping, Content Dedup, Dead Portal Detection (v1.9.0)

| Change | File | Description |
|--------|------|-------------|
| Domain-based portal grouping | `scripts/commands/playlist/portalScraper.ts` | Portals grouped by `extractDomain()` instead of username. e.g., `! Portals - cord-cutter.net:8080` (merged 13 users), `! Portals - hardcoremedia.xyz` (merged 9 users) — 27 groups → 5 groups |
| Title-based fingerprint dedup | `scripts/commands/playlist/portalScraper.ts` | Uses `jaccard()` similarity on first 25 channel titles. Portals with >70% identical channel names are duplicates — keeps only the one with the most streams |
| Cross-portal URL dedup | `scripts/commands/playlist/portalScraper.ts` | Streams deduplicated by URL across all portals within a domain group — eliminates duplicate stream links |
| Dead portal detection | `scripts/commands/playlist/portalScraper.ts` | `verifyPortal()` now rejects XUI.one debug pages (`<html>`, `XUI.one`, `Debug Mode`) and M3U responses with <5 real stream entries |
| Version bump | `IPTV_VERSION.md` | Updated to 1.9.0 |

### June 30, 2026 — English-Only Stream Filter + Domain-Level Adult Filter (v1.8.0)

| Change | File | Description |
|--------|------|-------------|
| English-only stream filter | `scripts/commands/playlist/portalScraper.ts` | Added `hasNonLatinScript()` — filters streams with Arabic, Cyrillic, CJK, Japanese, Korean, Thai, Greek, Hebrew, Devanagari characters. Applied in both M3U parsing and Xtream API fetching |
| get.php English verification | `scripts/commands/playlist/portalScraper.ts` | Samples first 30 EXTINF lines from get.php, skips portal if ≥30% non-English stream names |
| Domain-level adult filter | `scripts/commands/playlist/portalScraper.ts` | Added `ADULT_DOMAIN_PATTERNS` — skips portals with xxx, adult, porn, sex, onlyfans in domain name (e.g. xxx13.shop caught) |
| Version bump | `IPTV_VERSION.md` | Updated to 1.8.0 |

### June 30, 2026 — Portal Scraper Adult Filter + Duplicate Stream Numbering (v1.7.0)

| Change | File | Description |
|--------|------|-------------|
| Adult category pre-filter | `scripts/commands/playlist/portalScraper.ts` | Fetches `get_live_categories` per verified portal; skips portal entirely if ≥30% categories match adult keywords (xxx, porn, sex, adult, etc.) |
| Adult stream name filter | `scripts/commands/playlist/portalScraper.ts` | Filters individual streams by `category_name` and stream `name` against adult keyword lists (includes studio names: Brazzers, BangBros, Pornhub, etc.) |
| Duplicate stream numbering | `scripts/commands/playlist/portalScraper.ts` | Duplicate titles within a portal get `str N - ` prefix (e.g. `str 2 - ESPN`, `str 3 - ESPN`); first occurrence stays clean |
| get.php verification fallback | `scripts/commands/playlist/portalScraper.ts` | `verifyPortal()` now falls back to `get.php` (M3U) when `player_api.php` returns 404 — ~46% of XML2 portals respond to `get.php` with valid M3U playlists |
| M3U stream fetching | `scripts/commands/playlist/portalScraper.ts` | Added `fetchPortalStreamsM3u()` — parses raw M3U from `get.php` when Xtream JSON API is unavailable; parses tvg-id, tvg-logo, channel names |
| Dual-mode fetch | `scripts/commands/playlist/portalScraper.ts` | `fetchPortalStreams()` now tries Xtream API first, falls back to `get.php` M3U parsing automatically |
| Adult check for M3U portals | `scripts/commands/playlist/portalScraper.ts` | `verifyPortal()` samples first 30 EXTINF lines from `get.php` response; skips portal if ≥30% match adult stream keywords |
| Re-enabled Reddit API | `scripts/commands/playlist/portalScraper.ts` | Reddit public JSON API fixed via `fetchContent()` — tries direct request first, falls back to 4 CORS proxies (allorigins.win, corsproxy.io, codetabs, cors.lol). PlayTorrio IPTV Generator uses same approach. |
| Configurable GitHub repos + CORS proxies | `scripts/commands/playlist/portalScraper.ts` | Replaced hardcoded single-repo fetch with `GITHUB_PORTAL_REPOS` config array; added `CORS_PROXIES` array for Reddit fallback |
| PlayTorrio investigation | `iptvgen.pages.dev` | PlayTorrio IPTV Generator uses identical sources (Reddit r/IPTV_ZONENEW + GitHub akeotaseo/world_repo XML2). Routes Reddit through CORS proxies. Verifies portals via `player_api.php` only. Has full paste.sh AES-256-CBC decryption. |
| Version bump | `IPTV_VERSION.md` | Updated to 1.7.0 |

### June 29, 2026 — Removed SportsHD Scraper + 24hr Pacific Time Filter + Pre-Write Stream Check

| Change | File | Description |
|--------|------|-------------|
| Removed SportsHD scraper | `scripts/commands/playlist/sportshdScraper.ts` | Kodi addon-based scraper never produced working streams — removed entirely |
| Removed from pipeline | `scripts/commands/playlist/generateUltimate.ts` | Removed import, scraper call, and 'SportsHD' from scraperNames |
| Removed from reorganizer | `scripts/core/reorganizer.ts` | Removed SportsHD from per-sport grouping classification |
| 24hr PT filter utility | `scripts/core/aggregatorHelpers.ts` | Added `isWithin24hrsPT(timestampMs)` — checks if a Unix timestamp is within 24 hours of current Pacific time |
| Time filter Streamed | `scripts/commands/playlist/streamedScraper.ts` | Filters matches by `match.date` to only include events within 24hrs PT |
| Time filter VIPRow | `scripts/commands/playlist/vipboxScraper.ts` | Filters events by `event.time` to only include within 24hrs PT |
| Pre-write stream check | `scripts/commands/playlist/generateUltimate.ts` | Added `checkStreams()` — runs HEAD/GET Range on all streams (50 concurrent, 10s timeout) before writing final M3U, removes streams returning fatal errors (ECONNREFUSED, ENOTFOUND, 404, 410, 000) |
| Version bump | `IPTV_VERSION.md` | Updated to 1.5.0 |

### June 29, 2026 — Stream Check Workflow (v1.6.0)

| Change | File | Description |
|--------|------|-------------|
| Stream check workflow | `.github/workflows/stream-check.yml` | New `workflow_dispatch` GitHub Actions workflow to validate streams on demand. Supports scope (ultimate/all/path), fix mode, sampled checking. |
| Stream check script | `scripts/commands/playlist/streamCheck.ts` | Standalone stream validator — random-samples streams from a playlist, checks HEAD/GET Range (8s timeout, 100 concurrent), reports status codes per-group, saves report to job summary. |
| npm script | `package.json` | Added `playlist:streamcheck` command |
| Version bump | `IPTV_VERSION.md` | Updated to 1.6.0 |

### June 29, 2026 — Xtream-Codes Portal Scraper (v1.5.1 — Bug Fix)

| Change | File | Description |
|--------|------|-------------|
| Portal scraper | `scripts/commands/playlist/portalScraper.ts` | New scraper — scrapes Xtream-Codes portals from GitHub XML2 dumps (akeotaseo/world_repo) and Reddit RSS, verifies via player_api.php, fetches live streams from verified portals |
| Pipeline integration | `scripts/commands/playlist/generateUltimate.ts` | Added `scrapePortals()` before sports scrapers — runs every 24h during ultimate playlist generation |
| Portal section at top | `scripts/core/reorganizer.ts` | Added `'portals'` as first entry in `SECTION_ORDER` — portal streams appear at the very top of the M3U |
| Fixed JUNK_TOKENS filtering | `scripts/commands/playlist/portalScraper.ts` | Removed `type=m3u`, `output=ts`, `password=`, `username=` from JUNK_TOKENS — every legitimate portal URL was hitting ≥2 tokens, causing `isJunk()` to discard all GitHub XML2 content (2,579 portals found after fix). Also dropped OAuth2 Reddit (403 blocked), switched to direct JSON with proper UA. CORS proxies not needed in Node.js. |
| Version bump | `IPTV_VERSION.md` | Updated to 1.5.1 |

### June 28, 2026 — SportsHD Scraper + Dead DrewLive Removal

| Change | File | Description |
|--------|------|-------------|
| SportsHD scraper | `scripts/commands/playlist/sportshdScraper.ts` | New scraper extracting events from super.league.st + 24/7 channels from one.sporthd.me TRPC API |
| Pipeline integration | `generateUltimate.ts` | Added as 12th parallel scraper in Promise.allSettled |
| Group classification | `scripts/core/reorganizer.ts` | Preserves per-sport grouping for SportsHD (e.g. `! Sports - SportsHD - NFL`) |
| Removed MadTitan | `generateUltimate.ts` | All 482 streams returning 404 from lucidhosting.xyz:82 |
| Removed PixelSport | `generateUltimate.ts` | All 78 streams returning 403 from locked.pixelpanel.online |
| Removed TVPass | `generateUltimate.ts` | Domain tvpass.org unreachable (HTTP 000) |
| Analyzed The Crew repo | `team-crew.github.io` | Sports section is RoxieStreams wrapper + bitbucket XMLs (auth-required); no new source value |
| Analyzed Loop repo | `loopaddon.uk/theloop` | Behind OVH/Google anti-bot, unreachable for scraping; general media addon |
| Version bump | `IPTV_VERSION.md` | Updated to 1.4.0 |

### June 28, 2026 — Script Exit Fix (Workflow Reliability)

| Change | File | Description |
|--------|------|-------------|
| Fixed process hang on success | `generateUltimate.ts` | Added `process.exit(0)` on successful completion — Node.js kept alive by leftover handles (Playwright, axios), causing workflow timeout |
| Same fix | `mergeAllM3u.ts` | Added `.then(() => process.exit(0))` |
| Same fix | `generateEpg.ts` | Added `.then(() => process.exit(0))` |
| Version bump | `IPTV_VERSION.md` | Updated to 1.3.0 |

### June 28, 2026 — Sportsurge, StreamEast, LiveTV Scrapers + DrewLive Playlists

| Change | File | Description |
|--------|------|-------------|
| Sportsurge scraper | `scripts/commands/playlist/sportsurgeScraper.ts` | New scraper for sportsurge.net + 2 mirrors — Playwright page parse + network intercept for m3u8 |
| StreamEast scraper | `scripts/commands/playlist/streamEastScraper.ts` | New scraper for thestreameast.lol + 2 mirrors — same Playwright pattern |
| LiveTV scraper | `scripts/commands/playlist/liveTvScraper.ts` | New scraper for livetv.sx/enx/ — scrapes 24 sport keywords, eachLimit 5 for resolution |
| Pipeline integration | `generateUltimate.ts` | All 3 new scrapers registered in imports, Promise.allSettled, and scraperNames array |
| Group classification | `scripts/core/reorganizer.ts` | Preserves per-sport grouping for Sportsurge/StreamEast/LiveTV (e.g. `! Sports - Sportsurge - NBA`) |
| Added MadTitan playlist | `generateUltimate.ts` | Fetches MadTitan.m3u8 from DrewLive repo — ~1400 streams (24/7 shows, UFC, kids) from lucidhosting.xyz |
| Added PixelSport playlist | `generateUltimate.ts` | Fetches Pixelsports.m3u8 from DrewLive repo — ~200+ live sports streams (NBA, NHL, NFL, MLB) |
| Added TVPass playlist | `generateUltimate.ts` | Fetches TVPass.m3u from DrewLive repo — ~500+ US cable/network channels (ABC, CNN, ESPN, HBO, etc.) |
| Version bump | `IPTV_VERSION.md` | Updated to 1.2.0 |

### June 28, 2026 — GitHub Actions Workflow Fixes

| Change | File | Description |
|--------|------|-------------|
| Fixed EPG Docker timeout | `.github/workflows/ultimate.yml` | Reduced wait loop from 240→90 iterations to fit within 120m job timeout |
| Fixed EPG Docker timeout | `.github/workflows/merge-all.yml` | Reduced wait loop from 180→45 iterations, increased job timeout 60→90m |
| Added Docker container check | `ultimate.yml`, `merge-all.yml` | Verifies container started (`docker ps`) before polling loop |
| Fixed postinstall | `ultimate.yml` | Changed `npm install` → `npm install --ignore-scripts` to skip API download |
| Fixed commit user | `merge-all.yml` | Changed from `Robbdeeze` to `github-actions[bot]` for GITHUB_TOKEN compat |
| Fixed branch diff | `.github/workflows/check.yml` | Uses `pull_request.base.sha` when available, falls back to `origin/master` |

### June 26, 2026 — Playlist & EPG Refresh

| Change | File | Description |
|--------|------|-------------|
| Refreshed playlist | `Robbdeeze_UltimateTV.m3u` | Regenerated with 17,790 streams total |
| Regenerated EPG | `Robbdeeze_UltimateTV_Epg.xml` | Updated EPG data from guide sources |
| Updated Famelack data | `streams/us_famelack.m3u`, `streams/uk_famelack.m3u` | Refreshed US (1,547) and UK (239) channels |
| Streamed.pk sports | `streamedScraper.ts` | Scraped 108 live sports streams |
| Updated IPTV_VERSION.md | `IPTV_VERSION.md` | Documented latest run

### June 27, 2026 — DrewLive Source Update

| Change | File | Description |
|--------|------|-------------|
| Replaced dead DrewLive URLs | `generateUltimate.ts` | Replaced broken `eradhossain/DrewLive` PPVLand/TheTVApp URLs with working `drewlive2423.duckdns.org:8045/DrewLive/DrewLiveMergedPlaylist.m3u8` |
| Preserve original group titles | `stream.ts` | `Stream.fromPlaylistItem()` now preserves `group-title` from M3U files |
| Conditional group override | `generateUltimate.ts` | External playlists with no override group-title keep their original internal groups |
| Filter non-US/UK/CA regions | `generateUltimate.ts` | Filtered out PlutoTV/SamsungTVPlus/PlexTV entries for countries other than US, UK, and Canada |

### June 27, 2026 — File System Restructure

| Change | File | Description |
|--------|------|-------------|
| Organized `streams/` into subdirs | `streams/` | Moved 325 files into `countries/` (200), `sources/` (123), and `generated/` (2) |
| Updated linter glob | `m3u-linter.json` | Changed `streams/*.m3u` → `streams/**/*.m3u` for recursive matching |
| Updated workflow paths | `ultimate.yml` | Changed `streams/*.m3u` → `streams/**/*.m3u` for commit patterns |
| Updated famelack output path | `generateUltimate.ts` | Famelack files now write to `streams/generated/` |

### June 27, 2026 — Bug Fix: Group-Title Parsing

| Change | File | Description |
|--------|------|-------------|
| Fixed group-title extraction | `stream.ts` | `data.group` from `iptv-playlist-parser` is an object `{title: string}`, not a plain string. `typeof check` was causing all DrewLive streams to get group-title `"Undefined"`. Now handles both formats. |

### June 27, 2026 — Bug Fix: Shared Browser Race Condition

| Change | File | Description |
|--------|------|-------------|
| Centralized browser lifecycle | `roxieScraper.ts`, `sportyHunterScraper.ts`, `ntvScraper.ts`, `sportsBiteScraper.ts`, `ppvToScraper.ts`, `streamedScraper.ts` | Removed `closeBrowser()` from all 6 scrapers using the shared singleton browser. The first scraper to finish was closing the browser for all others still running, causing `browser.newContext: Target page, context or browser has been closed`. |
| Centralized cleanup | `generateUltimate.ts` | Added single `await closeBrowser()` after `Promise.allSettled()` completes |

### June 27, 2026 — Performance Optimizations

| Change | File | Description |
|--------|------|-------------|
| Parallel scrapers | `generateUltimate.ts` | All 7 sports scrapers now run concurrently via `Promise.allSettled` instead of sequentially |
| Faster embed extraction | `aggregatorHelpers.ts` | Reduced `waitUntil: 'networkidle'` → `'domcontentloaded'`, 20s→15s timeout, removed 5s extra wait |
| Shared helpers in streamedScraper | `streamedScraper.ts` | Replaced local `extractM3u8FromEmbed`/`getBrowser`/`closeBrowser` copies with shared imports from `aggregatorHelpers` |
| Concurrent embed resolution | `streamedScraper.ts` | Stream embed URLs now resolved 5 at a time using `async.eachLimit` instead of one-by-one |

### EPG Automation Enhancements

| Change | File | Before | After |
|--------|------|--------|-------|
| Increased EPG coverage | `ultimate.yml` | `DAYS=1` | `DAYS=3` |
| Extended timeout | `ultimate.yml` | 180 min (3h) | 240 min (4h) |
| Better error logging | `ultimate.yml` | `--tail 50` | `--tail 100` |
| Graceful Docker stop | `ultimate.yml` | `docker stop epg` | `docker stop epg \|\| true` |
| Status indicators | `ultimate.yml` | Plain text | Emoji indicators (✅❌) |
| Cleaner wait messages | `ultimate.yml` | `"Waiting... (${i}/180 minutes)"` | `"Waiting... (${i}/240)"` |
| Zero-match warning | `generateEpg.ts` | No check | `logger.warn('No channels matched!...')` |
| Updated commit message | `ultimate.yml` | `"[Bot] Update Robbdeeze_UltimateTV playlist, EPG, and imported streams"` | `"[Bot] Update Robbdeeze_UltimateTV playlist and EPG"` |
| EPG documentation | `README.md` | Minimal EPG section | Added URLs + daily generation note |

### New Sports Scrapers

| Change | File | Description |
|--------|------|-------------|
| Shared helper module | `scripts/core/aggregatorHelpers.ts` | Extracted `getBrowser()`, `closeBrowser()`, `extractM3u8FromEmbed()`, `createStream()`, `fetchWithTimeout()` into reusable utilities |
| NTV scraper | `scripts/commands/playlist/ntvScraper.ts` | New scraper for `ntvs.cx` + 2 mirrors — extracts live channels and resolves m3u8 via page parsing + Playwright |
| SportsBite scraper | `scripts/commands/playlist/sportsBiteScraper.ts` | New scraper for `sportsbite.lol` + 2 mirrors — extracts vs-events and resolves m3u8 from watch pages |
| PPV.TO scraper | `scripts/commands/playlist/ppvToScraper.ts` | New scraper for `ppv.to` — scrapes PPV/live events, finds m3u8 via iframe, script vars, and Playwright |
| RoxieStreams scraper | `scripts/commands/playlist/roxieScraper.ts` | New scraper for `roxiestreams.info` + 2 mirrors — events + inline JSON stream data extraction |
| SportyHunter scraper | `scripts/commands/playlist/sportyHunterScraper.ts` | New scraper for `sportyhunter.com` + 2 mirrors — events + schedule sections parsing |
| Integration | `scripts/commands/playlist/generateUltimate.ts` | All 5 new scrapers imported and called in the main UltimateTV pipeline |
| Core re-exports | `scripts/core/index.ts` | Added `aggregatorHelpers` to public exports |

### June 27, 2026 — Successful Pipeline Run

| Change | File | Description |
|--------|------|-------------|
| Generated playlist | `Robbdeeze_UltimateTV.m3u` | Regenerated with 26,409 streams after dedup |
| Sports scrapers | daddyliveScraper, streamedScraper, roxieScraper | DaddyLive: 425, Streamed: 101, Roxie: 1 live event streams |
| Clean URL in README | `README.md` | Added `Robbdeeze_UltimateTV_Clean.m3u` to Playlists section |
| Updated IPTV_VERSION.md | `IPTV_VERSION.md` | Documented latest run |

### June 27, 2026 — Auto-Update Reliability Fixes

| Change | File | Description |
|--------|------|-------------|
| Scraper timeouts | `generateUltimate.ts` | Added 5-minute timeout per scraper via `withTimeout()` — prevents a single hung scraper from blocking the entire pipeline |
| Global timeout | `generateUltimate.ts` | Added 55-minute global timeout wrapper around `main()` — prevents 6-hour workflow runs from hitting GitHub's job timeout |
| Robust git diff | `check.yml` | Fixed "Get list of changed files" step to handle detached HEAD and fetch failures gracefully |

### June 27, 2026 — Playlist Reorganization & Cleanup

| Change | File | Description |
|--------|------|-------------|
| Reorganizer module | `scripts/core/reorganizer.ts` | New shared module that classifies all streams into clean hierarchical categories |
| Pipeline integration | `generateUltimate.ts` | Reorganization runs automatically after dedup in the main pipeline |
| Core re-export | `scripts/core/index.ts` | Added `reorganizer` to public exports |
| Standalone reorg script | `scripts/commands/playlist/reorg.ts` | Can also be run standalone |
| Clean output | `Robbdeeze_UltimateTV_Clean.m3u` | Generated with 26,388 entries across 19 category sections |
| Section ordering | All streams | Sports Live/PPV/Events at top → News → US → Canada → UK → Other → VOD at bottom |
| VOD TV Shows grouped | VOD section | TV show episodes organized under `VOD - TV Shows - {ShowName}` |
| US before UK | Section order | US groups placed above UK groups throughout the playlist |

### June 27, 2026 — VOD Separation & Main Playlist Cleanup

| Change | File | Description |
|--------|------|-------------|
| Moved VOD to separate files | `streams/vod/movies.m3u`, `streams/vod/tv-shows.m3u` | Copied VOD source files from local Documents to repo under `streams/vod/` for independent hosting |
| Stripped VOD from main playlists | `Robbdeeze_UltimateTV.m3u`, `Robbdeeze_UltimateTV_Clean.m3u` | Removed 13,009 VOD entries (26,019 lines) from each — main playlists now contain only live channels (13,400 streams) |
| Removed VOD from pipeline | `generateUltimate.ts` | Removed local VOD file reading and insertion blocks — VOD no longer embedded during generation |
| Added VOD to README | `README.md` | New "Movies & TV Shows (VOD)" section with raw GitHub URLs to `streams/vod/movies.m3u` and `streams/vod/tv-shows.m3u` |
| Documented VOD separation | `IPTV_VERSION.md` | Updated project overview, output files table, file structure, and workflow descriptions to reflect VOD-isolated architecture |

### June 27, 2026 — Stream Health Check System

| Change | File | Description |
|--------|------|-------------|
| Quick pre-check in stream tester | `scripts/core/streamTester.ts` | Added `quickCheck()` method that does HEAD (5s) → GET with Range fallback before mediainfo.js analysis. Dead streams (ECONNREFUSED, ENOTFOUND, 404, 410, timeout) return immediately, skipping expensive mediainfo — speeds up `playlist:test --fix` significantly |
| Lightweight health check script | `scripts/commands/playlist/quickHealthCheck.ts` | New HTTP-only validator (no mediainfo) inspired by `iptv-m3u-bot`. 10s timeout, 50 concurrent workers. Identifies dead streams fast for frequent runs |
| npm scripts | `package.json` | Added `playlist:health` (check only) and `playlist:health:fix` (auto-remove dead streams) |
| Continuous health check workflow | `.github/workflows/health-check.yml` | Runs every 60 minutes via cron, executes `quickHealthCheck.ts --fix`, commits/pushes any pruned streams. Keeps playlist healthy between full daily regenerations |

### June 27, 2026 — Sports Event Start Times + Adult Sources

| Change | File | Description |
|--------|------|-------------|
| Start time in stream titles | `scripts/core/aggregatorHelpers.ts` | Added `formatTimePT()` (converts unix ts → Pacific) and `extractTimeFromText()` (extracts time from raw text) helpers |
| DaddyLive time prefix | `scripts/commands/playlist/daddyliveScraper.ts` | Passes `event.time` through to stream titles as `[HH:MM] Event - Channel` |
| Streamed time prefix | `scripts/commands/playlist/streamedScraper.ts` | Converts `match.date` (unix ts) to PT and prepends `[HH:MM am/pm PT]` to titles |
| SportsBite time prefix | `scripts/commands/playlist/sportsBiteScraper.ts` | Extracts time from link text, prepends `[HH:MM]` to titles |
| PPV.TO time prefix | `scripts/commands/playlist/ppvToScraper.ts` | Extracts time from link text, prepends `[HH:MM]` to titles |
| Roxie time prefix | `scripts/commands/playlist/roxieScraper.ts` | Extracts time from link text, prepends `[HH:MM]` to titles |
| SportyHunter time prefix | `scripts/commands/playlist/sportyHunterScraper.ts` | Extracts time from link text, prepends `[HH:MM]` to titles |
| Adult IPTV sources | `scripts/commands/playlist/generateUltimate.ts`, `mergeAllM3u.ts` | Added 25 adultiptv.net categories + IPTVjs Adult under `! Adult` group |
| Adult section in reorganizer | `scripts/core/reorganizer.ts` | Classifies `! Adult` group into the `adult` section for proper ordering |
| NTV dependency cleanup | `scripts/commands/playlist/ntvScraper.ts` | Removed unused `closeBrowser` import |
| Version tracking | `IPTV_VERSION.md` | Added `Version: 1.0.0` header, documented all changes |

---

### June 27, 2026 — VIPBox/VIPRow Niche Sports Scraper

| Change | File | Description |
|--------|------|-------------|
| VIPRow scraper | `scripts/commands/playlist/vipboxScraper.ts` | New scraper for `viprow.nu` — scrapes tennis, rugby, motorsports, volleyball, and other niche sports |
| Pipeline integration | `scripts/commands/playlist/generateUltimate.ts` | Added `scrapeVipbox` as 8th sports scraper in the parallel pipeline |
| VIPRow group classification | `scripts/core/reorganizer.ts` | Preserves per-sport grouping for VIPRow streams (e.g. `! Sports - VIPRow - Tennis`) |
| Unused import cleanup | Various scrapers | Removed unused `closeBrowser` imports from SportsBite, PPV.TO, Roxie, SportyHunter scrapers |
| Lint fix | `vipboxScraper.ts` | Fixed CRLF line endings to match project convention |

---

## 13. How to Run Locally

```bash
# Clone and install
git clone https://github.com/Robbdeeze/iptv.git
cd iptv
npm install    # Also runs api:load postinstall

# Generate the UltimateTV playlist + EPG
npm run playlist:ultimate

# Generate channels.xml for Docker EPG
npx tsx scripts/commands/playlist/generateEpg.ts --channels-xml channels.xml

# Run Docker EPG (requires Docker)
docker run -d --name epg \
  -v $PWD:/epg/public:Z \
  -p 3000:3000 \
  -e MAX_CONNECTIONS=5 \
  -e DAYS=3 \
  ghcr.io/iptv-org/epg:master

# Wait for guide.xml then process it
curl -o guide.xml http://localhost:3000/guide.xml
npx tsx scripts/commands/playlist/generateEpg.ts --process-guide guide.xml

# Merge all streams
npm run playlist:mergeAll

# Quick health check (HTTP-only, no mediainfo)
npm run playlist:health          # Check only
npm run playlist:health:fix      # Check + remove dead streams

# Full stream testing (with mediainfo analysis)
npm run playlist:test -- --fix

# Run tests
npm test

# Lint
npm run lint
```
