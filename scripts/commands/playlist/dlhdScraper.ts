import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { extractM3u8FromEmbed, createStream } from '../../core'
import { fetchWithTimeout } from '../../core'

const GROUP_TITLE = '! Sports - DLHD'

const MIRRORS = [
  'https://dlhd.st',
  'https://dlhd.sx',
  'https://dlhd.lol',
]

interface DlhdChannel {
  name: string
  id: string
}

interface DlhdEvent {
  title: string
  url: string
}

async function findActiveMirror(logger: Logger): Promise<string | null> {
  for (const mirror of MIRRORS) {
    try {
      const html = await fetchWithTimeout(`${mirror}/`, 10000)
      if (html && html.includes('daddylive') || (html && html.includes('DaddyLive'))) {
        logger.info(`Active DLHD mirror: ${mirror}`)
        return mirror
      }
    } catch {
      continue
    }
  }
  return null
}

async function extractChannels(domain: string, logger: Logger): Promise<DlhdChannel[]> {
  const channels: DlhdChannel[] = []

  try {
    const html = await fetchWithTimeout(`${domain}/24-7-channels.php`, 15000)
    if (!html) return channels

    const channelRegex = /href="\/watch\.php\?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi
    let match
    const seen = new Set<string>()

    while ((match = channelRegex.exec(html)) !== null) {
      const id = match[1]
      const name = match[2].replace(/<[^>]*>/g, '').trim()
      if (name && !seen.has(id)) {
        seen.add(id)
        channels.push({ name, id })
      }
    }

    logger.info(`Found ${channels.length} channels on DLHD 24/7`)
  } catch (err: any) {
    logger.error(`DLHD channel extraction error: ${err.message || err}`)
  }

  return channels
}

async function extractEvents(domain: string, logger: Logger): Promise<DlhdEvent[]> {
  const events: DlhdEvent[] = []

  try {
    const html = await fetchWithTimeout(`${domain}/`, 15000)
    if (!html) return events

    const eventRegex = /<a[^>]*href="([^"]*schedule[^"]*|event[^"]*|watch[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
    let match
    const seen = new Set<string>()

    while ((match = eventRegex.exec(html)) !== null) {
      const href = match[1]
      const text = match[2].replace(/<[^>]*>/g, '').trim()
      if (!href || href === '/' || href === '#') continue
      if (text.length < 3) continue

      const fullUrl = href.startsWith('http') ? href : `${domain}${href}`
      if (!seen.has(fullUrl) && (text.toLowerCase().includes(' vs ') || text.toLowerCase().includes('live'))) {
        seen.add(fullUrl)
        events.push({ title: text, url: fullUrl })
      }
    }

    logger.info(`Found ${events.length} events on DLHD schedule`)
  } catch (err: any) {
    logger.error(`DLHD event extraction error: ${err.message || err}`)
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

    const iframeMatch = html.match(/<iframe[^>]*src=["']([^"']+)["']/i)
    if (iframeMatch) {
      const iframeUrl = iframeMatch[1].startsWith('http') ? iframeMatch[1] : `${new URL(eventUrl).origin}${iframeMatch[1]}`
      const iframeHtml = await fetchWithTimeout(iframeUrl, 10000)
      if (iframeHtml) {
        const iframeM3u8 = iframeHtml.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)
        if (iframeM3u8) return iframeM3u8[0]
      }
      return await extractM3u8FromEmbed(iframeUrl, logger)
    }

    return await extractM3u8FromEmbed(eventUrl, logger)
  } catch {
    return await extractM3u8FromEmbed(eventUrl, logger)
  }
}

export async function scrapeDlhd(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== DLHD Scraper ===')
  const domain = await findActiveMirror(logger)
  if (!domain) {
    logger.error('No active DLHD mirror found')
    return result
  }

  const channels = await extractChannels(domain, logger)
  const events = await extractEvents(domain, logger)

  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  for (const channel of channels) {
    const streamUrl = `${domain}/stream/stream-${channel.id}.php`
    const m3u8Url = await resolveStreamUrl(streamUrl, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      streams.push(createStream(channel.name, m3u8Url, GROUP_TITLE))
      logger.info(`  DLHD: ${channel.name}`)
    }
  }

  for (const event of events) {
    const m3u8Url = await resolveStreamUrl(event.url, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      streams.push(createStream(event.title, m3u8Url, GROUP_TITLE))
      logger.info(`  DLHD Event: ${event.title.substring(0, 60)}...`)
    }
  }

  logger.info(`Total DLHD streams: ${streams.length}`)

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
