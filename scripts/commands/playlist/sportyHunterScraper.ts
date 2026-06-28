import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { extractM3u8FromEmbed, createStream, extractTimeFromText } from '../../core'
import { fetchWithTimeout } from '../../core'

const GROUP_TITLE = '! Sports - SportyHunter'

const MIRRORS = [
  'https://sportyhunter.com',
  'https://sportyhunter.lol',
  'https://sportyhunter.xyz',
]

interface SportyEvent {
  title: string
  url: string
  sport?: string
  league?: string
}

async function findActiveMirror(logger: Logger): Promise<string | null> {
  for (const mirror of MIRRORS) {
    try {
      const html = await fetchWithTimeout(`${mirror}/`, 10000)
      if (html && (html.includes('sporty') || html.includes('hunter') || html.includes('stream'))) {
        logger.info(`Active SportyHunter mirror: ${mirror}`)
        return mirror
      }
    } catch {
      continue
    }
  }
  return null
}

async function extractEvents(domain: string, logger: Logger): Promise<SportyEvent[]> {
  const events: SportyEvent[] = []

  try {
    const html = await fetchWithTimeout(`${domain}/`, 15000)
    if (!html) return events

    const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    let match
    const seen = new Set<string>()

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1]
      const text = match[2].replace(/<[^>]*>/g, '').trim()
      if (!href || href === '/' || href === '#') continue
      if (text.length < 3) continue

      const fullUrl = href.startsWith('http') ? href : `${domain}${href}`

      if (
        !seen.has(fullUrl) &&
        (text.toLowerCase().includes(' vs ') ||
         href.includes('watch') ||
         href.includes('live') ||
         href.includes('stream') ||
         href.includes('game') ||
         href.includes('sport'))
      ) {
        seen.add(fullUrl)

        let league = ''
        const sport = ''
        const pathParts = href.split('/').filter(Boolean)
        if (pathParts.length > 1) {
          const possibleLeague = pathParts[pathParts.length - 2].replace(/[-_]/g, ' ')
          if (possibleLeague.length < 20) league = possibleLeague
        }

        events.push({ title: text, url: fullUrl, sport, league })
      }
    }

    const scheduleSections = html.match(/<div[^>]*class=["'][^"']*(?:schedul|event|match|game)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)
    if (scheduleSections) {
      for (const section of scheduleSections) {
        const itemRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
        while ((match = itemRegex.exec(section)) !== null) {
          const href = match[1]
          const text = match[2].replace(/<[^>]*>/g, '').trim()
          if (!href || href === '/' || href === '#') continue
          if (text.length < 3) continue
          const fullUrl = href.startsWith('http') ? href : `${domain}${href}`
          if (!seen.has(fullUrl)) {
            seen.add(fullUrl)
            events.push({ title: text, url: fullUrl })
          }
        }
      }
    }

    logger.info(`Found ${events.length} events on SportyHunter`)
  } catch (err: any) {
    logger.error(`SportyHunter extraction error: ${err.message || err}`)
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

    const scriptMatch = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
    if (scriptMatch) return scriptMatch[1]

    return await extractM3u8FromEmbed(eventUrl, logger)
  } catch {
    return await extractM3u8FromEmbed(eventUrl, logger)
  }
}

export async function scrapeSportyHunter(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== SportyHunter Scraper ===')
  const domain = await findActiveMirror(logger)
  if (!domain) {
    logger.error('No active SportyHunter mirror found')
    return result
  }

  const events = await extractEvents(domain, logger)
  if (events.length === 0) {
    logger.warn('No events found on SportyHunter')
    return result
  }

  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  let maxResolve = 25
  for (const event of events) {
    if (maxResolve <= 0) break
    maxResolve--

    const m3u8Url = await resolveEventStream(event.url, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      const timePrefix = extractTimeFromText(event.title)
      const leaguePrefix = event.league ? `[${event.league}] ` : event.sport ? `[${event.sport}] ` : ''
      const title = timePrefix
        ? `[${timePrefix}] ${leaguePrefix}${event.title.replace(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?/i, '').trim()}`
        : `${leaguePrefix}${event.title}`
      streams.push(createStream(title, m3u8Url, GROUP_TITLE))
      logger.info(`  SportyHunter: ${title.substring(0, 60)}...`)
    }
  }

  logger.info(`Total SportyHunter streams: ${streams.length}`)

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
