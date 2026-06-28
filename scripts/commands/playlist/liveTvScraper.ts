import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { getBrowser, createStream } from '../../core/aggregatorHelpers'
import { fetchWithTimeout, extractM3u8FromEmbed } from '../../core/aggregatorHelpers'
import { eachLimit } from 'async'

const BASE_URL = 'https://livetv.sx'

interface LiveTVEvent {
  name: string
  url: string
  sport: string
  time: string
}

const SPORT_KEYWORDS: { keyword: string; sport: string }[] = [
  { keyword: 'football', sport: 'Football' },
  { keyword: 'soccer', sport: 'Football' },
  { keyword: 'basketball', sport: 'Basketball' },
  { keyword: 'hockey', sport: 'Hockey' },
  { keyword: 'nhl', sport: 'Hockey' },
  { keyword: 'baseball', sport: 'Baseball' },
  { keyword: 'mlb', sport: 'Baseball' },
  { keyword: 'tennis', sport: 'Tennis' },
  { keyword: 'boxing', sport: 'Boxing' },
  { keyword: 'ufc', sport: 'MMA' },
  { keyword: 'mma', sport: 'MMA' },
  { keyword: 'motogp', sport: 'Motorsports' },
  { keyword: 'formula 1', sport: 'Motorsports' },
  { keyword: 'f1', sport: 'Motorsports' },
  { keyword: 'nascar', sport: 'Motorsports' },
  { keyword: 'rugby', sport: 'Rugby' },
  { keyword: 'golf', sport: 'Golf' },
  { keyword: 'cricket', sport: 'Cricket' },
  { keyword: 'volleyball', sport: 'Volleyball' },
  { keyword: 'handball', sport: 'Handball' },
  { keyword: 'wrestling', sport: 'Wrestling' },
  { keyword: 'darts', sport: 'Darts' },
  { keyword: 'snooker', sport: 'Snooker' },
  { keyword: 'cycling', sport: 'Cycling' },
]

function classifySport(title: string): string {
  const lower = title.toLowerCase()
  for (const { keyword, sport } of SPORT_KEYWORDS) {
    if (lower.includes(keyword)) return sport
  }
  return 'Other'
}

async function extractEvents(logger: Logger): Promise<LiveTVEvent[]> {
  const events: LiveTVEvent[] = []

  try {
    const browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()

    try {
      await page.goto(`${BASE_URL}/enx/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)

      const links = await page.evaluate(() => {
        const items: { name: string; url: string; time: string }[] = []
        const anchors = document.querySelectorAll('a[href]')
        const seen = new Set<string>()

        anchors.forEach((a) => {
          const href = (a as HTMLAnchorElement).href
          const text = (a.textContent || '').trim()
          if (!text || !href || seen.has(href)) return
          seen.add(href)

          const timeEl = a.querySelector('.time, [class*="time"]')
          const time = timeEl ? timeEl.textContent?.trim() || '' : ''

          if (href.includes('/enx/event') || href.includes('/enx/events') || href.includes('.php')) {
            items.push({ name: text, url: href, time })
          }
        })

        return items
      })

      for (const link of links) {
        const sport = classifySport(link.name)
        events.push({ name: link.name, url: link.url, sport, time: link.time })
      }

      logger.info(`Found ${events.length} events on LiveTV`)
    } catch (err: any) {
      logger.error(`LiveTV page parse error: ${err.message || err}`)
    } finally {
      await context.close()
    }
  } catch (err: any) {
    logger.error(`LiveTV browser error: ${err.message || err}`)
  }

  return events
}

async function resolveLiveTVEvent(url: string, logger: Logger): Promise<string | null> {
  try {
    const html = await fetchWithTimeout(url, 10000)
    if (html) {
      const m3u8Match = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)
      if (m3u8Match) return m3u8Match[0]
    }

    return await extractM3u8FromEmbed(url, logger)
  } catch {
    return await extractM3u8FromEmbed(url, logger)
  }
}

export async function scrapeLiveTV(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== LiveTV Scraper ===')

  const events = await extractEvents(logger)
  if (events.length === 0) return result

  const grouped = new Map<string, Stream[]>()
  const seenUrls = new Set<string>()

  let resolved = 0
  const resolveJobs = events.slice(0, 50).map((event) => ({ event, groupTitle: `! Sports - LiveTV - ${event.sport}` }))

  await eachLimit(resolveJobs, 5, async (job) => {
    const { event, groupTitle } = job

    if (!grouped.has(event.sport)) grouped.set(event.sport, [])

    logger.info(`[${++resolved}/${resolveJobs.length}] Resolving: ${event.name} (${event.sport})`)
    const m3u8Url = await resolveLiveTVEvent(event.url, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      const title = event.time ? `[${event.time}] ${event.name}` : event.name
      const streams = grouped.get(event.sport)!
      streams.push(createStream(title, m3u8Url, groupTitle))
      logger.info(`  -> ${m3u8Url.substring(0, 80)}...`)
    }
  })

  for (const [sport, streams] of grouped) {
    if (streams.length > 0) {
      logger.info(`LiveTV ${sport}: ${streams.length} streams`)
      result.push({ groupTitle: `! Sports - LiveTV - ${sport}`, streams })
    }
  }

  return result
}
