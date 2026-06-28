import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { getBrowser, createStream } from '../../core'
import { fetchWithTimeout } from '../../core/aggregatorHelpers'

const MIRRORS = [
  'https://streameast.ga',
  'https://streameast.ph',
  'https://streameast.to',
]

interface StreamEastEvent {
  name: string
  url: string
  sport: string
}

async function findActiveMirror(logger: Logger): Promise<string | null> {
  for (const mirror of MIRRORS) {
    try {
      const html = await fetchWithTimeout(`${mirror}/`, 10000)
      if (html && (html.includes('streameast') || html.includes('StreamEast') || html.includes('StreamEast'))) {
        logger.info(`Active StreamEast mirror: ${mirror}`)
        return mirror
      }
    } catch {
      continue
    }
  }
  return null
}

async function extractEvents(domain: string, logger: Logger): Promise<StreamEastEvent[]> {
  const events: StreamEastEvent[] = []

  try {
    const browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()

    try {
      await page.goto(`${domain}/`, { waitUntil: 'domcontentloaded', timeout: 20000 })
      await page.waitForTimeout(3000)

      const links = await page.evaluate(() => {
        const items: { name: string; url: string; sport: string }[] = []
        const anchors = document.querySelectorAll('a[href]')
        const seen = new Set<string>()

        anchors.forEach((a) => {
          const href = (a as HTMLAnchorElement).href
          const text = (a.textContent || '').trim()
          if (!text || !href || seen.has(href)) return
          seen.add(href)

          const lower = text.toLowerCase()
          let sport = 'Other'
          if (lower.includes('nfl') || lower.includes('nfl')) sport = 'NFL'
          else if (lower.includes('nba')) sport = 'NBA'
          else if (lower.includes('nhl')) sport = 'NHL'
          else if (lower.includes('mlb')) sport = 'MLB'
          else if (lower.includes('ufc') || lower.includes('boxing')) sport = 'UFC/Boxing'
          else if (lower.includes('soccer') || lower.includes('football')) sport = 'Soccer'
          else if (lower.includes('ncaa') || lower.includes('college')) sport = 'NCAA'
          else if (lower.includes('tennis')) sport = 'Tennis'
          else if (lower.includes('golf')) sport = 'Golf'
          else if (lower.includes('motogp') || lower.includes('f1')) sport = 'Motorsports'
          else if (lower.includes('wwe') || lower.includes('aew') || lower.includes('wrestling')) sport = 'Wrestling'

          if (href.includes('/event/') || href.includes('/live/') || href.includes('/watch/')) {
            items.push({ name: text, url: href, sport })
          }
        })

        return items
      })

      for (const link of links) {
        events.push({ name: link.name, sport: link.sport, url: link.url })
      }

      logger.info(`Found ${events.length} events on StreamEast`)
    } catch (err: any) {
      logger.error(`StreamEast page parse error: ${err.message || err}`)
    } finally {
      await context.close()
    }
  } catch (err: any) {
    logger.error(`StreamEast browser error: ${err.message || err}`)
  }

  return events
}

async function resolveStreamUrl(url: string, logger: Logger): Promise<string | null> {
  try {
    const browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })
    const page = await context.newPage()

    try {
      const m3u8Url = await new Promise<string | null>((resolve) => {
        page.on('response', (response) => {
          const respUrl = response.url()
          if (respUrl.includes('.m3u8') && !respUrl.includes('.ts')) {
            resolve(respUrl)
          }
        })

        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
        setTimeout(async () => {
          const src = await page.evaluate(() => {
            const video = document.querySelector('video')
            return video ? video.src : null
          }).catch(() => null)
          if (src && src.includes('.m3u8')) resolve(src)
        }, 8000)

        setTimeout(() => resolve(null), 15000)
      })

      return m3u8Url
    } finally {
      await context.close()
    }
  } catch {
    return null
  }
}

export async function scrapeStreamEast(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== StreamEast Scraper ===')
  const domain = await findActiveMirror(logger)
  if (!domain) {
    logger.error('No active StreamEast mirror found')
    return result
  }

  const events = await extractEvents(domain, logger)
  if (events.length === 0) return result

  const grouped = new Map<string, Stream[]>()
  const seenUrls = new Set<string>()

  let maxEvents = 40
  for (const event of events) {
    if (maxEvents <= 0) break
    maxEvents--

    const groupTitle = `! Sports - StreamEast - ${event.sport}`
    if (!grouped.has(event.sport)) grouped.set(event.sport, [])

    logger.info(`Resolving: ${event.name} (${event.sport})`)
    const m3u8Url = await resolveStreamUrl(event.url, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      const streams = grouped.get(event.sport)!
      streams.push(createStream(event.name, m3u8Url, groupTitle))
      logger.info(`  -> ${m3u8Url.substring(0, 80)}...`)
    }
  }

  for (const [sport, streams] of grouped) {
    if (streams.length > 0) {
      logger.info(`StreamEast ${sport}: ${streams.length} streams`)
      result.push({ groupTitle: `! Sports - StreamEast - ${sport}`, streams })
    }
  }

  return result
}
