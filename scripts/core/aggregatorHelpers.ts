import { Logger } from '@freearhey/core'
import { Stream } from '../models'
import { chromium, Browser } from 'playwright'

let browserInstance: Browser | null = null

export async function getBrowser(): Promise<Browser> {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
  }
  return browserInstance
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close()
    browserInstance = null
  }
}

export async function extractM3u8FromEmbed(
  embedUrl: string,
  logger: Logger
): Promise<string | null> {
  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })

  const m3u8Urls: string[] = []

  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.includes('.m3u8') || url.includes('.mpd')) {
      m3u8Urls.push(url)
    }
    await route.continue()
  })

  context.on('response', (response) => {
    const url = response.url()
    if (url.includes('.m3u8')) {
      m3u8Urls.push(url)
    }
  })

  try {
    const page = await context.newPage()
    await page.goto(embedUrl, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(5000)

    const pageM3u8 = await page.evaluate(() => {
      const found: string[] = []
      document.querySelectorAll('video').forEach((v) => {
        if (v.src && v.src.includes('.m3u8')) found.push(v.src)
        v.querySelectorAll('source').forEach((s) => {
          if (s.src && s.src.includes('.m3u8')) found.push(s.src)
        })
      })
      document.querySelectorAll('iframe').forEach((iframe) => {
        if (iframe.src && iframe.src.includes('.m3u8')) found.push(iframe.src)
      })
      return found
    })
    m3u8Urls.push(...pageM3u8)

    const unique = [...new Set(m3u8Urls)]
    if (unique.length > 0) return unique[0]
  } catch {
    return null
  } finally {
    await context.close()
  }

  return null
}

export function createStream(
  title: string,
  url: string,
  groupTitle: string,
  tvgId?: string
): Stream {
  const stream = new Stream({
    channel: null,
    feed: null,
    title,
    url,
    quality: null,
    referrer: null,
    user_agent: null,
    label: null
  })
  stream.tvgId = tvgId || title
  stream.tvgLogo = ''
  stream.groupTitle = groupTitle
  return stream
}

export async function fetchWithTimeout(
  url: string,
  timeout = 15000
): Promise<string | null> {
  try {
    const { default: axios } = await import('axios')
    const response = await axios.get(url, {
      timeout,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    return response.data
  } catch {
    return null
  }
}
