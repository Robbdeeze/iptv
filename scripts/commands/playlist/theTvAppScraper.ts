import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { extractM3u8FromEmbed, createStream } from '../../core'
import { fetchWithTimeout } from '../../core'

const GROUP_TITLE = '! Sports - TheTVApp'

const SPORT_SLUGS = [
  'nba-streams', 'mlb-streams', 'nhl-streams', 'nfl-streams',
  'soccer-streams', 'cfb-streams', 'ncaab-streams',
  'f1-streams', 'wwe-streams', 'boxing-streams', 'mma-streams',
]

async function extractEvents(sportUrl: string, logger: Logger): Promise<{ title: string; url: string; sport: string }[]> {
  const events: { title: string; url: string; sport: string }[] = []

  try {
    const html = await fetchWithTimeout(sportUrl, 15000)
    if (!html) return events

    const eventRegex = /<a[^>]*href="(\/tv-live\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let match
    const seen = new Set<string>()

    while ((match = eventRegex.exec(html)) !== null) {
      const href = match[1]
      const text = match[2].replace(/<[^>]*>/g, '').trim()
      if (!text || seen.has(href)) continue
      seen.add(href)
      const sport = sportUrl.split('/').pop()?.replace('-streams', '').toUpperCase() || 'Sport'
      events.push({ title: text, url: `https://thetvappv2.com${href}`, sport })
    }

    return events
  } catch (err: any) {
    logger.error(`TheTVApp event extraction error: ${err.message || err}`)
    return events
  }
}

async function resolveStreamUrl(eventUrl: string, logger: Logger): Promise<string | null> {
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

export async function scrapeTheTvApp(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== TheTVApp Scraper ===')

  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  for (const slug of SPORT_SLUGS) {
    const sportUrl = `https://thetvappv2.com/watch/${slug}`
    const events = await extractEvents(sportUrl, logger)
    logger.info(`TheTVApp ${slug}: ${events.length} events`)

    let maxResolve = 10
    for (const event of events) {
      if (maxResolve <= 0) break
      maxResolve--

      const m3u8Url = await resolveStreamUrl(event.url, logger)
      if (m3u8Url && !seenUrls.has(m3u8Url)) {
        seenUrls.add(m3u8Url)
        const title = `[${event.sport}] ${event.title}`
        streams.push(createStream(title, m3u8Url, GROUP_TITLE))
        logger.info(`  TheTVApp: ${title.substring(0, 60)}...`)
      }
    }
  }

  logger.info(`Total TheTVApp streams: ${streams.length}`)

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
