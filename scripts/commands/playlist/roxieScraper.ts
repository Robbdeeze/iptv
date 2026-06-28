import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { extractM3u8FromEmbed, createStream, extractTimeFromText } from '../../core'
import { fetchWithTimeout } from '../../core'

const GROUP_TITLE = '! Sports - Roxie'

const MIRRORS = [
  'https://roxiestreams.info',
  'https://roxiestreams.live',
  'https://roxiesports.com',
]

interface RoxieEvent {
  title: string
  url: string
  sport?: string
}

async function findActiveMirror(logger: Logger): Promise<string | null> {
  for (const mirror of MIRRORS) {
    try {
      const html = await fetchWithTimeout(`${mirror}/`, 10000)
      if (html && (html.includes('roxie') || html.includes('stream') || html.includes('sport'))) {
        logger.info(`Active Roxie mirror: ${mirror}`)
        return mirror
      }
    } catch {
      continue
    }
  }
  return null
}

async function extractEvents(domain: string, logger: Logger): Promise<RoxieEvent[]> {
  const events: RoxieEvent[] = []

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
         href.includes('watch') ||
         href.includes('live') ||
         href.includes('stream') ||
         href.includes('game') ||
         href.includes('event'))
      ) {
        seen.add(fullUrl)

        let sport = ''
        const pathParts = href.split('/').filter(Boolean)
        if (pathParts.length > 1) {
          const possibleSport = pathParts[pathParts.length - 2].replace(/[-_]/g, ' ')
          if (possibleSport.length < 15) sport = possibleSport
        }

        events.push({ title: text, url: fullUrl, sport })
      }
    }

    const scriptMatch = html.match(/var\s+streams\s*=\s*(\[[\s\S]*?\])\s*;/)
    if (scriptMatch) {
      try {
        const streamsData = JSON.parse(scriptMatch[1])
        for (const item of streamsData) {
          if (item.url && item.url.includes('.m3u8') && !seen.has(item.url)) {
            seen.add(item.url)
            events.push({ title: item.name || 'Roxie Stream', url: item.url, sport: item.sport })
          }
        }
      } catch {
        // JSON parse failed, ignore
      }
    }

    logger.info(`Found ${events.length} events on RoxieStreams`)
  } catch (err: any) {
    logger.error(`Roxie extraction error: ${err.message || err}`)
  }

  return events
}

async function resolveStreamUrl(eventUrl: string, logger: Logger): Promise<string | null> {
  if (eventUrl.includes('.m3u8')) return eventUrl

  try {
    const html = await fetchWithTimeout(eventUrl, 10000)
    if (!html) return await extractM3u8FromEmbed(eventUrl, logger)

    const m3u8Match = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)
    if (m3u8Match) return m3u8Match[0]

    const embedRegex = /<iframe[^>]*src=["']([^"']+)["']/i
    const iframeMatch = html.match(embedRegex)
    if (iframeMatch) {
      const iframeUrl = iframeMatch[1].startsWith('http') ? iframeMatch[1] : `${new URL(eventUrl).origin}${iframeMatch[1]}`
      return await extractM3u8FromEmbed(iframeUrl, logger)
    }

    const scriptM3u8 = html.match(/["']([^"']+\.m3u8[^"']*?)["']/i)
    if (scriptM3u8) return scriptM3u8[1]

    return await extractM3u8FromEmbed(eventUrl, logger)
  } catch {
    return await extractM3u8FromEmbed(eventUrl, logger)
  }
}

export async function scrapeRoxie(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== RoxieStreams Scraper ===')
  const domain = await findActiveMirror(logger)
  if (!domain) {
    logger.error('No active RoxieStreams mirror found')
    return result
  }

  const events = await extractEvents(domain, logger)
  if (events.length === 0) {
    logger.warn('No events found on RoxieStreams')
    return result
  }

  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  let maxResolve = 25
  for (const event of events) {
    if (maxResolve <= 0) break
    maxResolve--

    const m3u8Url = await resolveStreamUrl(event.url, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      const timePrefix = extractTimeFromText(event.title)
      const sportPrefix = event.sport ? `[${event.sport}] ` : ''
      const title = timePrefix
        ? `[${timePrefix}] ${sportPrefix}${event.title.replace(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?/i, '').trim()}`
        : `${sportPrefix}${event.title}`
      streams.push(createStream(title, m3u8Url, GROUP_TITLE))
      logger.info(`  Roxie: ${title.substring(0, 60)}...`)
    }
  }

  logger.info(`Total RoxieStreams streams: ${streams.length}`)

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
