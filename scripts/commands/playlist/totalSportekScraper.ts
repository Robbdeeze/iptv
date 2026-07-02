import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { getBrowser, createStream } from '../../core'
import { fetchWithTimeout } from '../../core'

const GROUP_TITLE = '! Sports - TotalSportek'

const MIRRORS = [
  'https://totalsporteka.com',
  'https://totalsporteky.com',
]

async function findActiveMirror(logger: Logger): Promise<string | null> {
  for (const mirror of MIRRORS) {
    try {
      const html = await fetchWithTimeout(`${mirror}/`, 10000)
      if (html && (html.includes('TotalSportek') || html.includes('totalsportek') || html.includes('sportek'))) {
        logger.info(`Active TotalSportek mirror: ${mirror}`)
        return mirror
      }
    } catch {
      continue
    }
  }
  return null
}

async function extractM3u8Playwright(url: string, logger: Logger): Promise<string | null> {
  try {
    const browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
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

        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
        setTimeout(async () => {
          const src = await page.evaluate(() => {
            const video = document.querySelector('video')
            return video ? video.src : null
          }).catch(() => null)
          if (src && src.includes('.m3u8')) resolve(src)
        }, 10000)

        setTimeout(() => resolve(null), 20000)
      })

      return m3u8Url
    } finally {
      await context.close()
    }
  } catch {
    return null
  }
}

async function resolveStreamUrl(eventUrl: string, logger: Logger): Promise<string | null> {
  if (eventUrl.includes('.m3u8')) return eventUrl

  try {
    const html = await fetchWithTimeout(eventUrl, 10000)
    if (!html) return await extractM3u8Playwright(eventUrl, logger)

    const m3u8Match = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/)
    if (m3u8Match) return m3u8Match[0]

    const iframeMatch = html.match(/<iframe[^>]*src=["']([^"']+)["']/i)
    if (iframeMatch) {
      const iframeUrl = iframeMatch[1].startsWith('http') ? iframeMatch[1] : `${new URL(eventUrl).origin}${iframeMatch[1]}`
      return await extractM3u8Playwright(iframeUrl, logger)
    }

    return await extractM3u8Playwright(eventUrl, logger)
  } catch {
    return await extractM3u8Playwright(eventUrl, logger)
  }
}

export async function scrapeTotalSportek(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== TotalSportek Scraper ===')
  const domain = await findActiveMirror(logger)
  if (!domain) {
    logger.error('No active TotalSportek mirror found')
    return result
  }

  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  try {
    const browser = await getBrowser()
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()

    try {
      await page.goto(`${domain}/`, { waitUntil: 'networkidle', timeout: 30000 })
      await page.waitForTimeout(5000)

      const links = await page.evaluate(() => {
        const items: { name: string; url: string }[] = []
        const anchors = document.querySelectorAll('a[href]')
        const seen = new Set<string>()

        anchors.forEach((a) => {
          const href = (a as HTMLAnchorElement).href
          const text = (a.textContent || '').trim()
          if (!text || !href || seen.has(href) || href === '#' || href.includes('javascript')) return
          seen.add(href)
          if (
            href.includes('/match/') ||
            href.includes('/event/') ||
            href.includes('/live/') ||
            href.includes('/stream/') ||
            href.includes('/watch/') ||
            (text.toLowerCase().includes(' vs ') && !href.includes('#'))
          ) {
            items.push({ name: text, url: href })
          }
        })

        return items
      })

      logger.info(`Found ${links.length} potential events on TotalSportek`)

      let maxResolve = 25
      for (const link of links) {
        if (maxResolve <= 0) break
        maxResolve--

        const m3u8Url = await resolveStreamUrl(link.url, logger)
        if (m3u8Url && !seenUrls.has(m3u8Url)) {
          seenUrls.add(m3u8Url)
          streams.push(createStream(link.name, m3u8Url, GROUP_TITLE))
          logger.info(`  TotalSportek: ${link.name.substring(0, 60)}...`)
        }
      }
    } catch (err: any) {
      logger.error(`TotalSportek page error: ${err.message || err}`)
    } finally {
      await context.close()
    }
  } catch (err: any) {
    logger.error(`TotalSportek browser error: ${err.message || err}`)
  }

  logger.info(`Total TotalSportek streams: ${streams.length}`)

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
