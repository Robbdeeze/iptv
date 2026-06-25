import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import axios from 'axios'
import { chromium } from 'playwright'

const GROUP_TITLE = '! Sports - Streamed'

interface MatchSource {
  source: string
  id: string
}

interface TeamInfo {
  name: string
  badge?: string
}

interface Match {
  id: string
  title: string
  category: string
  date: number
  popular?: boolean
  teams?: { home?: TeamInfo; away?: TeamInfo }
  sources: MatchSource[]
}

interface StreamOption {
  id: string
  streamNo: number
  language: string
  hd: boolean
  embedUrl: string
  source: string
  viewers: number
}

// Shared browser instance for embed extraction
let browserInstance: import('playwright').Browser | null = null

async function getBrowser(): Promise<import('playwright').Browser> {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
  }
  return browserInstance
}

async function extractM3u8FromEmbed(
  embedUrl: string,
  logger: Logger
): Promise<string | null> {
  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })

  const m3u8Urls: string[] = []

  // Intercept network requests for m3u8 URLs
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.includes('.m3u8') || url.includes('.mpd')) {
      m3u8Urls.push(url)
    }
    await route.continue()
  })

  context.on('response', (response) => {
    const url = response.url()
    if (url.includes('.m3u8')) {
      m3u8Urls.push(url)
    }
  })

  try {
    const page = await context.newPage()
    await page.goto(embedUrl, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(5000)

    // Check page for video/iframe sources
    const pageM3u8 = await page.evaluate(() => {
      const found: string[] = []
      document.querySelectorAll('video').forEach((v) => {
        if (v.src && v.src.includes('.m3u8')) found.push(v.src)
        v.querySelectorAll('source').forEach((s) => {
          if (s.src && s.src.includes('.m3u8')) found.push(s.src)
        })
      })
      document.querySelectorAll('iframe').forEach((iframe) => {
        if (iframe.src && iframe.src.includes('.m3u8')) found.push(iframe.src)
      })
      return found
    })
    m3u8Urls.push(...pageM3u8)

    const unique = [...new Set(m3u8Urls)]
    if (unique.length > 0) return unique[0]
  } catch {
    return null
  } finally {
    await context.close()
  }

  return null
}

async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close()
    browserInstance = null
  }
}

function isEnglishOrNoLanguage(lang: string): boolean {
  const lower = lang.toLowerCase()
  return (
    !lower ||
    lower === 'english' ||
    lower.startsWith('english') ||
    lower.includes('eng')
  )
}

export async function scrapeStreamed(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []
  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  const domain = 'https://streamed.pk'

  try {
    // Step 1: Get all sports categories
    logger.info('Fetching sports categories...')
    const sportsResp = await axios.get(`${domain}/api/sports`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const sports: { id: string; name: string }[] = sportsResp.data
    logger.info(`Found ${sports.length} sport categories`)

    // Step 2: Fetch matches for each sport
    const allMatches: Match[] = []
    for (const sport of sports) {
      try {
        const matchesResp = await axios.get(`${domain}/api/matches/${sport.id}`, {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        })
        const matches: Match[] = matchesResp.data
        if (matches.length > 0) {
          allMatches.push(...matches)
          logger.info(`  ${sport.name}: ${matches.length} matches`)
        }
      } catch {
        // Some sports might not have matches
      }
    }

    logger.info(`Total matches: ${allMatches.length}`)

    if (allMatches.length === 0) {
      return result
    }

    // Step 3: For each match, get stream options and extract m3u8
    let matchCount = 0
    for (const match of allMatches) {
      matchCount++
      const title = match.title

      // Process each source for this match
      for (const source of match.sources) {
        try {
          const streamResp = await axios.get(
            `${domain}/api/stream/${source.source}/${source.id}`,
            {
              timeout: 15000,
              headers: { 'User-Agent': 'Mozilla/5.0' }
            }
          )
          const options: StreamOption[] = streamResp.data

          if (!options || options.length === 0) continue

          // Prefer English HD streams
          const englishHD = options.filter(
            (o) => isEnglishOrNoLanguage(o.language) && o.hd
          )
          const english = options.filter((o) =>
            isEnglishOrNoLanguage(o.language)
          )
          const chosen =
            englishHD.length > 0
              ? englishHD[0]
              : english.length > 0
                ? english[0]
                : options[0]

          // Extract m3u8 from the embed URL using Playwright
          logger.info(
            `  [${matchCount}/${allMatches.length}] ${title} - ${chosen.language}${chosen.hd ? ' HD' : ''}`
          )
          const m3u8Url = await extractM3u8FromEmbed(chosen.embedUrl, logger)
          if (m3u8Url && !seenUrls.has(m3u8Url)) {
            seenUrls.add(m3u8Url)
            const stream = new Stream({
              channel: null,
              feed: null,
              title,
              url: m3u8Url,
              quality: null,
              referrer: null,
              user_agent: null,
              label: null
            })
            stream.tvgId = title
            stream.tvgLogo = ''
            stream.groupTitle = GROUP_TITLE
            streams.push(stream)
            logger.info(`    -> m3u8 found: ${m3u8Url.substring(0, 80)}...`)
          }
        } catch {
          // Source might not be available
        }
      }
    }

    logger.info(
      `Total Streamed streams: ${streams.length}`
    )
  } catch (err: any) {
    logger.error(`Streamed scraper failed: ${err.message || err}`)
  } finally {
    await closeBrowser()
  }

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
