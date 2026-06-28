import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { extractM3u8FromEmbed, createStream, extractTimeFromText } from '../../core'
import { fetchWithTimeout } from '../../core'

const GROUP_TITLE = '! Sports - PPV'

const BASE_URL = 'https://ppv.to'

interface PpvEvent {
  title: string
  url: string
  date?: string
  category?: string
}

async function extractEvents(logger: Logger): Promise<PpvEvent[]> {
  const events: PpvEvent[] = []

  try {
    const html = await fetchWithTimeout(`${BASE_URL}/`, 15000)
    if (!html) return events

    const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    let match
    const seen = new Set<string>()

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1]
      const text = match[2].replace(/<[^>]*>/g, '').trim()
      if (!href || href === '/' || href === '#') continue
      if (text.length < 3) continue

      const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`

      if (
        !seen.has(fullUrl) &&
        (text.toLowerCase().includes(' vs ') ||
         href.includes('watch') ||
         href.includes('live') ||
         href.includes('ppv') ||
         href.includes('event') ||
         href.includes('stream'))
      ) {
        seen.add(fullUrl)

        let category = ''
        const pathParts = href.split('/').filter(Boolean)
        if (pathParts.length > 1) {
          const possibleCat = pathParts[pathParts.length - 2].replace(/[-_]/g, ' ')
          if (possibleCat.length < 20) category = possibleCat
        }

        events.push({ title: text, url: fullUrl, category })
      }
    }

    logger.info(`Found ${events.length} events on PPV.TO`)
  } catch (err: any) {
    logger.error(`PPV.TO extraction error: ${err.message || err}`)
  }

  return events
}

async function extractM3u8FromPage(
  pageUrl: string,
  logger: Logger
): Promise<string | null> {
  try {
    const html = await fetchWithTimeout(pageUrl, 10000)
    if (!html) return await extractM3u8FromEmbed(pageUrl, logger)

    const m3u8Match = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)
    if (m3u8Match) return m3u8Match[0]

    const iframeMatch = html.match(/<iframe[^>]*src=["']([^"']+)["']/i)
    if (iframeMatch) {
      const iframeUrl = iframeMatch[1].startsWith('http') ? iframeMatch[1] : `${new URL(pageUrl).origin}${iframeMatch[1]}`
      return await extractM3u8FromEmbed(iframeUrl, logger)
    }

    const scriptMatch = html.match(/src:\s*["']([^"']+\.m3u8[^"']*)["']/i)
    if (scriptMatch) return scriptMatch[1]

    const sourceMatch = html.match(/file:\s*["']([^"']+\.m3u8[^"']*)["']/i)
    if (sourceMatch) return sourceMatch[1]

    return await extractM3u8FromEmbed(pageUrl, logger)
  } catch {
    return await extractM3u8FromEmbed(pageUrl, logger)
  }
}

export async function scrapePpvTo(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== PPV.TO Scraper ===')
  const events = await extractEvents(logger)
  if (events.length === 0) {
    logger.warn('No events found on PPV.TO')
    return result
  }

  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  let maxResolve = 25
  for (const event of events) {
    if (maxResolve <= 0) break
    maxResolve--

    const m3u8Url = await extractM3u8FromPage(event.url, logger)
    if (m3u8Url && !seenUrls.has(m3u8Url)) {
      seenUrls.add(m3u8Url)
      const timePrefix = extractTimeFromText(event.title)
      const categoryPrefix = event.category ? `[${event.category}] ` : ''
      const title = timePrefix
        ? `[${timePrefix}] ${categoryPrefix}${event.title.replace(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?/i, '').trim()}`
        : `${categoryPrefix}${event.title}`
      streams.push(createStream(title, m3u8Url, GROUP_TITLE))
      logger.info(`  PPV.TO: ${title.substring(0, 60)}...`)
    }
  }

  logger.info(`Total PPV.TO streams: ${streams.length}`)

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
