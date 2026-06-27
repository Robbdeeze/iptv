import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { extractM3u8FromEmbed, createStream, closeBrowser } from '../../core'
import { fetchWithTimeout } from '../../core'

const GROUP_TITLE = '! Sports - SportsBite'

const MIRRORS = [
  'https://sportsbite.lol',
  'https://sportsbite.xyz',
  'https://sportsbite.site',
]

interface SportsBiteEvent {
  title: string
  url: string
  sport?: string
  league?: string
}

async function findActiveMirror(logger: Logger): Promise<string | null> {
  for (const mirror of MIRRORS) {
    try {
      const html = await fetchWithTimeout(`${mirror}/`, 10000)
      if (html && (html.includes('sports') || html.includes('SportsBite') || html.includes('watch'))) {
        logger.info(`Active SportsBite mirror: ${mirror}`)
        return mirror
      }
    } catch {
      continue
    }
  }
  return null
}

async function extractEvents(domain: string, logger: Logger): Promise<SportsBiteEvent[]> {
  const events: SportsBiteEvent[] = []

  try {
    const html = await fetchWithTimeout(`${domain}/`, 15000)
    if (!html) return events

    const eventRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    let match
    const seen = new Set<string>()

    while ((match = eventRegex.exec(html)) !== null) {
      const href = match[1]
      const text = match[2].replace(/<[^>]*>/g, '').trim()
      if (!href || href === '/' || href === '#') continue
      if (text.length < 3) continue

      const fullUrl = href.startsWith('http') ? href : `${domain}${href}`

      if (
        !seen.has(fullUrl) &&
        (text.toLowerCase().includes(' vs ') ||
         text.toLowerCase().includes('live') ||
         text.toLowerCase().includes('stream') ||
         href.includes('watch') ||
         href.includes('live') ||
         href.includes('event') ||
         href.includes('game'))
      ) {
        seen.add(fullUrl)

        let league = ''
        let sport = ''
        const pathParts = href.split('/').filter(Boolean)
        if (pathParts.length > 1) {
          const possibleLeague = pathParts[pathParts.length - 2].replace(/[-_]/g, ' ')
          if (possibleLeague.length < 20) league = possibleLeague
        }

        events.push({ title: text, url: fullUrl, sport, league })
      }
    }

    logger.info(`Found ${events.length} events on SportsBite`)
  } catch (err: any) {
    logger.error(`SportsBite extraction error: ${err.message || err}`)
  }

  return events
}

async function resolveEventStream(eventUrl: string, logger: Logger): Promise<string | null> {
  try {
    const html = await fetchWithTimeout(eventUrl, 10000)
    if (!html) return await extractM3u8FromEmbed(eventUrl, logger)

    const m3u8Match = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)
    if (m3u8Match) return m3u8Match[0]

    const iframeMatch = html.match(/<iframe[^>]*src=["']([^"']+)["']/i)
    if (iframeMatch) {
      const iframeUrl = iframeMatch[1].startsWith('http') ? iframeMatch[1] : `${new URL(eventUrl).origin}${iframeMatch[1]}`
      return await extractM3u8FromEmbed(iframeUrl, logger)
    }

    return await extractM3u8FromEmbed(eventUrl, logger)
  } catch {
    return await extractM3u8FromEmbed(eventUrl, logger)
  }
}

export async function scrapeSportsBite(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== SportsBite Scraper ===')
  const domain = await findActiveMirror(logger)
  if (!domain) {
    logger.error('No active SportsBite mirror found')
    return result
  }

  const events = await extractEvents(domain, logger)
  if (events.length === 0) {
    logger.warn('No events found on SportsBite')
    return result
  }

  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  let maxResolve = 30
  for (const event of events) {
    if (maxResolve <= 0) break
    maxResolve--

    const m3u8Url = await resolveEventStream(event.url, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      const title = event.league ? `[${event.league}] ${event.title}` : event.title
      streams.push(createStream(title, m3u8Url, GROUP_TITLE))
      logger.info(`  SportsBite: ${title.substring(0, 60)}...`)
    }
  }

  logger.info(`Total SportsBite streams: ${streams.length}`)

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
