import { ROOT_DIR } from '../../constants'
import { Storage } from '@freearhey/storage-js'
import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { PlaylistParser, closeBrowser } from '../../core'
import { loadData } from '../../api'
import { scrapeDaddylive } from './daddyliveScraper'
import { scrapeStreamEast } from './streamEastScraper'
import { scrapeLiveTV } from './liveTvScraper'
import { scrapeStreamed } from './streamedScraper'
import { scrapeNtv } from './ntvScraper'
import { scrapeSportsBite } from './sportsBiteScraper'
import { scrapePpvTo } from './ppvToScraper'
import { scrapeRoxie } from './roxieScraper'
import { scrapeSportyHunter } from './sportyHunterScraper'
import { scrapeVipbox } from './vipboxScraper'
import { scrapeSportsurge } from './sportsurgeScraper'
import { scrapePortals } from './portalScraper'
import { eachLimit } from 'async'
import axios from 'axios'

const SCRAPER_TIMEOUT = 5 * 60 * 1000
const CHECK_TIMEOUT = 10000
const CHECK_CONCURRENCY = 50

const FATAL_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN', 'HTTP_000'
])

const PORTAL_SPORTS_KEYWORDS = [
  'sport', 'espn', 'nfl', 'nba', 'nhl', 'mlb', 'ncaa', 'f1', 'motogp',
  'ufc', 'wwe', 'boxing', 'mma', 'racing', 'darts', 'snooker',
  'dazn', 'bein', 'sky sport', 'tnt sport', 'eurosport',
  'fox sport', 'cbs sport', 'nbcsn', 'golf', 'tennis', 'cricket',
  'rugby', 'cycling', 'volleyball', 'handball', 'hockey',
  'tsn', 'sportsnet', 'formula', 'motorsport',
  'soccer', 'football', 'basketball', 'baseball',
  'premier league', 'champions league', 'serie a', 'la liga',
  'redzone', 'nba tv', 'nhl network', 'mlb network',
  'fight', 'wrestling', 'ppv', 'live event',
  'olympics', 'athletics', 'badminton', 'table tennis',
  'water polo', 'horse racing', 'racing uk',
  'matchroom', 'fight sports', 'sporting',
  'box nation', 'fight club',
  'red bull tv', 'redbull',
  'motor', 'speed',
  'nfl channel', 'nba league pass',
  'mlb extra', 'nhl center ice', 'fox soccer',
  'eleven sports', 'viaplay', 'supersport',
  'sport tv', 'arena sport', 'sportklub',
  'cosmote sport', 'nova sport',
  'match!', 'matchtv', 'ptv sport',
  'beinsport', 'bein sport'
]

function isPortalSportsStream(stream: Stream): boolean {
  const title = (stream.title || '').toLowerCase()
  return PORTAL_SPORTS_KEYWORDS.some(kw => title.includes(kw))
}

function parseArg(key: string, def?: string): string | undefined {
  for (const a of process.argv) {
    if (a.startsWith(`--${key}=`)) return a.split('=')[1]
    if (a.startsWith(`--${key}`)) return 'true'
  }
  return def
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    )
  ])
}

function matchesSport(stream: Stream, sport: string): boolean {
  if (sport === 'all') return true
  const lower = sport.toLowerCase()
  const title = (stream.title || '').toLowerCase()
  const group = (stream.groupTitle || '').toLowerCase()
  return title.includes(lower) || group.includes(lower)
}

async function checkStreams(
  streams: Stream[],
  logger: Logger
): Promise<Stream[]> {
  const kept: Stream[] = []
  let alive = 0
  let dead = 0

  logger.info(`checking ${streams.length} streams for reachability...`)

  await eachLimit(streams, CHECK_CONCURRENCY, async (stream: Stream) => {
    try {
      const headRes = await axios.head(stream.url, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT),
        headers: { 'User-Agent': 'Mozilla/5.0' }
      })
      if (headRes.status === 200 || headRes.status === 206) {
        alive++
        kept.push(stream)
        return
      }

      const rangeRes = await axios.get(stream.url, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT),
        headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-1023' }
      })
      if (rangeRes.status === 200 || rangeRes.status === 206) {
        alive++
        kept.push(stream)
        return
      }

      kept.push(stream)
    } catch (err: unknown) {
      const error = err as { name?: string; code?: string; response?: { status: number }; cause?: { code?: string; name?: string } }
      let code = 'UNREACHABLE'
      if (error.name === 'CanceledError') code = 'TIMEOUT'
      else if (error.name === 'AxiosError' && error.response) code = `HTTP_${error.response.status}`
      else if (error.cause) code = error.cause.code || error.cause.name || code

      if (FATAL_NETWORK_CODES.has(code)) {
        dead++
        return
      }

      kept.push(stream)
    }
  })

  logger.info(`stream check: ${kept.length} kept (${alive} alive, ${dead} unreachable removed)`)
  return kept
}

async function main() {
  const sport = parseArg('sport', 'all')!
  const logger = new Logger()

  logger.info('=== Sports Scraper ===')
  logger.info(`Sport filter: "${sport}"`)

  logger.info('loading data from api...')
  await loadData()

  const scraperNames = ['DaddyLive', 'Streamed', 'NTV', 'SportsBite', 'PPV.TO', 'Roxie', 'SportyHunter', 'VIPRow', 'Sportsurge', 'StreamEast', 'LiveTV', 'Portals']

  logger.info('scraping sports streams...')
  const scraperResults = await Promise.allSettled([
    withTimeout(scrapeDaddylive(logger), SCRAPER_TIMEOUT, 'DaddyLive'),
    withTimeout(scrapeStreamed(logger), SCRAPER_TIMEOUT, 'Streamed'),
    withTimeout(scrapeNtv(logger), SCRAPER_TIMEOUT, 'NTV'),
    withTimeout(scrapeSportsBite(logger), SCRAPER_TIMEOUT, 'SportsBite'),
    withTimeout(scrapePpvTo(logger), SCRAPER_TIMEOUT, 'PPV.TO'),
    withTimeout(scrapeRoxie(logger), SCRAPER_TIMEOUT, 'Roxie'),
    withTimeout(scrapeSportyHunter(logger), SCRAPER_TIMEOUT, 'SportyHunter'),
    withTimeout(scrapeVipbox(logger), SCRAPER_TIMEOUT, 'VIPRow'),
    withTimeout(scrapeSportsurge(logger), SCRAPER_TIMEOUT, 'Sportsurge'),
    withTimeout(scrapeStreamEast(logger), SCRAPER_TIMEOUT, 'StreamEast'),
    withTimeout(scrapeLiveTV(logger), SCRAPER_TIMEOUT, 'LiveTV'),
    withTimeout(scrapePortals(logger), SCRAPER_TIMEOUT, 'Portals')
  ])

  await closeBrowser()

  const scrapedStreams: Stream[] = []

  for (let i = 0; i < scraperResults.length; i++) {
    const result = scraperResults[i]
    if (result.status === 'rejected') {
      logger.error(`${scraperNames[i]} scraper failed: ${result.reason}`)
      continue
    }
    const grouped = result.value
    const isPortalSource = scraperNames[i] === 'Portals'
    for (const { groupTitle, streams } of grouped) {
      let added = 0
      for (const stream of streams) {
        if (isPortalSource && !isPortalSportsStream(stream)) continue
        if (matchesSport(stream, sport)) {
          stream.groupTitle = 'Sports - Live / PPV / Events'
          scrapedStreams.push(stream)
          added++
        }
      }
      if (added > 0) {
        logger.info(`  ${scraperNames[i]}: ${added} streams matching "${sport}" in "${groupTitle}"`)
      }
    }
  }

  logger.info(`Total scraped streams matching "${sport}": ${scrapedStreams.length}`)

  if (scrapedStreams.length === 0) {
    logger.warn('No streams found. Exiting.')
    process.exit(0)
  }

  const checkedStreams = await checkStreams(scrapedStreams, logger)

  const rootStorage = new Storage(ROOT_DIR)
  const parser = new PlaylistParser({ storage: rootStorage })
  const existingFile = 'Robbdeeze_UltimateTV.m3u'
  const existingStreams: Stream[] = []

  const hasExisting = await rootStorage.exists(existingFile).catch(() => false)
  if (hasExisting) {
    const parsed = await parser.parse([existingFile])
    parsed.forEach((s: Stream) => existingStreams.push(s))
    logger.info(`Loaded ${existingStreams.length} existing streams from ${existingFile}`)
  } else {
    logger.info('No existing playlist found, creating new one')
  }

  const keptStreams = existingStreams

  const seenUrls = new Set<string>()
  const allStreams: Stream[] = []

  for (const s of keptStreams) {
    if (!seenUrls.has(s.url)) {
      seenUrls.add(s.url)
      allStreams.push(s)
    }
  }
  for (const s of checkedStreams) {
    if (!seenUrls.has(s.url)) {
      seenUrls.add(s.url)
      allStreams.push(s)
    }
  }

  logger.info(`Writing ${allStreams.length} streams (${keptStreams.length} existing + ${checkedStreams.length} new sport)`)

  let output = '#EXTM3U x-tvg-url="Robbdeeze_UltimateTV_Epg.xml.gz"\r\n'
  for (const stream of allStreams) {
    const tvgId = stream.getTvgId() || ''
    const tvgLogo = stream.getTvgLogo() || ''
    const groupTitle = stream.groupTitle || ''
    const title = stream.title || ''
    output += `#EXTINF:-1 tvg-id="${tvgId}" tvg-logo="${tvgLogo}" group-title="${groupTitle}",${title}\r\n${stream.url}\r\n`
  }

  await rootStorage.save(existingFile, output)
  logger.info(`Done! Playlist saved to ${existingFile}`)
}

main().then(() => {
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
