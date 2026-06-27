import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { extractM3u8FromEmbed, createStream, closeBrowser } from '../../core'
import { fetchWithTimeout } from '../../core'

const GROUP_TITLE = '! Sports - NTV'

const MIRRORS = [
  'https://ntvs.cx',
  'https://ntv.cx',
  'https://ntv.lol',
]

interface NtvChannel {
  name: string
  url: string
  source?: string
}

async function findActiveMirror(logger: Logger): Promise<string | null> {
  for (const mirror of MIRRORS) {
    try {
      const html = await fetchWithTimeout(`${mirror}/`, 10000)
      if (html && html.includes('ntv')) {
        logger.info(`Active NTV mirror: ${mirror}`)
        return mirror
      }
    } catch {
      continue
    }
  }
  return null
}

async function extractChannels(domain: string, logger: Logger): Promise<NtvChannel[]> {
  const channels: NtvChannel[] = []

  try {
    const html = await fetchWithTimeout(`${domain}/`, 15000)
    if (!html) return channels

    const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    let match
    const seen = new Set<string>()

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1]
      const text = match[2].replace(/<[^>]*>/g, '').trim()
      if (!href || href === '/' || href === '#') continue
      if (href.startsWith('http') || href.startsWith('/')) {
        const fullUrl = href.startsWith('http') ? href : `${domain}${href}`
        if (fullUrl.includes('.m3u8')) {
          const name = text || 'NTV Channel'
          if (!seen.has(fullUrl)) {
            seen.add(fullUrl)
            channels.push({ name, url: fullUrl, source: 'direct' })
          }
        } else if (
          text.toLowerCase().includes('watch') ||
          text.toLowerCase().includes('live') ||
          text.toLowerCase().includes('stream') ||
          text.toLowerCase().includes('channel')
        ) {
          if (!seen.has(fullUrl)) {
            seen.add(fullUrl)
            channels.push({ name: text || 'NTV Stream', url: fullUrl, source: 'page' })
          }
        }
      }
    }

    if (channels.length === 0) {
      const embedMatch = html.match(/src=["']([^"']*embed[^"']*)["']/i)
      if (embedMatch) {
        const embedUrl = embedMatch[1].startsWith('http') ? embedMatch[1] : `${domain}${embedMatch[1]}`
        channels.push({ name: 'NTV Live', url: embedUrl, source: 'embed' })
      }
    }
  } catch (err: any) {
    logger.error(`NTV extraction error: ${err.message || err}`)
  }

  return channels
}

async function resolveStreamUrl(channel: NtvChannel, logger: Logger): Promise<string | null> {
  if (channel.url.includes('.m3u8')) return channel.url

  if (channel.source === 'embed') {
    return await extractM3u8FromEmbed(channel.url, logger)
  }

  try {
    const html = await fetchWithTimeout(channel.url, 10000)
    if (!html) return null

    const m3u8Match = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)
    if (m3u8Match) return m3u8Match[0]

    const iframeMatch = html.match(/src=["']([^"']+)["'][^>]*>/i)
    if (iframeMatch) {
      const iframeUrl = iframeMatch[1].startsWith('http') ? iframeMatch[1] : `${new URL(channel.url).origin}${iframeMatch[1]}`
      return await extractM3u8FromEmbed(iframeUrl, logger)
    }

    return await extractM3u8FromEmbed(channel.url, logger)
  } catch {
    return null
  }
}

export async function scrapeNtv(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== NTV Scraper ===')
  const domain = await findActiveMirror(logger)
  if (!domain) {
    logger.error('No active NTV mirror found')
    return result
  }

  const channels = await extractChannels(domain, logger)
  logger.info(`Found ${channels.length} potential channels/streams on NTV`)

  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  for (const channel of channels) {
    const m3u8Url = await resolveStreamUrl(channel, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      streams.push(createStream(channel.name, m3u8Url, GROUP_TITLE))
      logger.info(`  NTV: ${channel.name} -> ${m3u8Url.substring(0, 80)}...`)
    }
  }

  logger.info(`Total NTV streams: ${streams.length}`)

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
