import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { extractM3u8FromEmbed, createStream, formatTimePT } from '../../core'
import { fetchWithTimeout } from '../../core'

const MIRRORS = [
  'https://vipbox1.com',
  'https://vipboxi.net',
  'https://viprow.pro',
  'https://viprow.sx',
]

const SPORTS_TO_SCRAPE = [
  { slug: 'tennis', name: 'Tennis' },
  { slug: 'rugby', name: 'Rugby' },
  { slug: 'moto_gp', name: 'Motorsports' },
  { slug: 'volleyball', name: 'Volleyball' },
  { slug: 'others', name: 'Other' },
]

interface VipboxEvent {
  sport: string
  name: string
  time: number
  links: string[]
}

async function findActiveMirror(logger: Logger): Promise<string | null> {
  for (const mirror of MIRRORS) {
    try {
      const html = await fetchWithTimeout(`${mirror}/`, 10000)
      if (html && (html.includes('vipbox') || html.includes('VIPBox') || html.includes('viprow'))) {
        logger.info(`Active VIPBox mirror: ${mirror}`)
        return mirror
      }
    } catch {
      continue
    }
  }
  return null
}

async function extractEvents(
  domain: string,
  sport: { slug: string; name: string },
  logger: Logger
): Promise<VipboxEvent[]> {
  const events: VipboxEvent[] = []
  try {
    const url = `${domain}/${sport.slug}`
    const html = await fetchWithTimeout(url, 15000)
    if (!html) return events

    const eventBlocks = html.match(/<h3[^>]*align=['"]left['"][^>]*>[\s\S]*?<\/h3>\s*<div[^>]*align=['"]left['"][^>]*>[\s\S]*?<\/div>\s*<\/div>/gi)
    if (!eventBlocks) return events

    for (const block of eventBlocks) {
      const timeMatch = block.match(/class=['"]dt\s+(\d+)['"]/)
      const nameMatch = block.match(/<span[^>]*>&nbsp;\s*([^<]+)<\/span>/)
      if (!nameMatch) continue

      const name = nameMatch[1].trim()
      const time = timeMatch ? parseInt(timeMatch[1], 10) * 1000 : 0

      const linkRegex = /<a[^>]*href=["'](https?:\/\/vipboxi\.net[^"']+)["']/gi
      const links: string[] = []
      let lm
      while ((lm = linkRegex.exec(block)) !== null) {
        links.push(lm[1])
      }

      if (links.length > 0) {
        events.push({ sport: sport.name, name, time, links })
      }
    }

    if (events.length > 0) {
      logger.info(`  ${sport.name}: ${events.length} events`)
    }
  } catch {
    // sport page might not exist
  }

  return events
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

export async function scrapeVipbox(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== VIPBox/VIPRow Scraper ===')
  const domain = await findActiveMirror(logger)
  if (!domain) {
    logger.error('No active VIPBox mirror found')
    return result
  }

  for (const sport of SPORTS_TO_SCRAPE) {
    const events = await extractEvents(domain, sport, logger)
    if (events.length === 0) continue

    const seenUrls = new Set<string>()
    const streams: Stream[] = []
    const groupTitle = `! Sports - VIPRow - ${sport.name}`

    let maxResolve = 15
    for (const event of events) {
      if (maxResolve <= 0) break
      for (const link of event.links) {
        if (maxResolve <= 0) break
        maxResolve--

        const m3u8Url = await resolveStreamUrl(link, logger)
        if (m3u8Url && !seenUrls.has(m3u8Url)) {
          seenUrls.add(m3u8Url)
          const timePrefix = event.time ? formatTimePT(event.time) : null
          const title = timePrefix
            ? `[${timePrefix}] ${event.name}`
            : event.name
          streams.push(createStream(title, m3u8Url, groupTitle))
          logger.info(`  ${sport.name}: ${title.substring(0, 60)}...`)
        }
      }
    }

    logger.info(`  Total ${sport.name} streams: ${streams.length}`)

    if (streams.length > 0) {
      result.push({ groupTitle, streams })
    }
  }

  return result
}
