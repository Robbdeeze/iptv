import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import axios from 'axios'
import { chromium } from 'playwright'

const GROUP_TITLE = '! Sports - DaddyLive'

// Known sports channel name patterns (lowercase) used to filter player9Data
const SPORTS_PATTERNS = [
  'sport', 'espn', 'nfl', 'nba', 'nhl', 'mlb', 'ncaa', 'f1', 'motogp',
  'ufc', 'wwe', 'boxing', 'mma', 'racing', 'darts', 'snooker',
  'dazn', 'bein sport', 'sky sport', 'tnt sport', 'eurosport',
  'fox sport', 'cbs sport', 'nbcsn', 'golf', 'tennis', 'cricket',
  'rugby', 'cycling', 'volleyball', 'handball', 'hockey',
  'tsn', 'sportsnet', 'atp', 'wta', 'formula', 'motorsport',
  'soccer', 'football', 'basketball', 'baseball',
  'premier league', 'champions league', 'serie a', 'la liga',
  'nfl redzone', 'nba tv', 'nhl network', 'mlb network',
  'fight', 'wrestling',
  'sportklub', 'arena sport', 'cosmote sport', 'nova sport',
  'match!', 'matchtv',
  'football.' /* Football. 1/2/3 */, 'sport tv',
  'eleven sport', 'viaplay',
  'supersport',
  'channel 4', 'channel 5', 'bbc one', 'bbc two', 'bbc three', 'bbc four',
  'itv', 'itv1', 'itv2', 'itv3', 'itv4',
  // Major broadcasters that carry sports
  'fox news', 'bbc news', 'sky news', 'nbc sport',
  'cbs', 'fox ',
  'servus tv', 'orf ',
  'rai ', 'canal+',
  'sport tv',
  'ptv sport',
]

const EVENTS_INTERESTING_CATEGORIES = [
  'popular live events', 'ppv events', 'soccer', 'football',
  'basketball', 'baseball', 'hockey', 'tennis', 'mma', 'boxing',
  'rugby', 'cricket', 'motorsports', 'f1', 'motogp',
  'ufc', 'nfl', 'nba', 'nhl', 'mlb', 'wwe', 'wrestling',
  'horse racing', 'darts', 'snooker', 'golf', 'cycling', 'volleyball',
  'handball', 'olympics', 'racing', 'athletics', 'badminton',
  'table tennis', 'water polo', 'field hockey', 'formula'
]

type PlayerEntry = {
  name: string
  url: string
  [key: string]: any
}

type EventChannel = {
  channel_name?: string
  channel_id?: string | number
  url?: string
  source?: string
  eventName?: string
}

type EventItem = {
  time?: string
  event?: string
  channels?: EventChannel[]
  source?: string
}

type DayData = {
  day?: string
  categories?: Record<string, EventItem[]>
}

function isSportsChannel(name: string): boolean {
  const lower = name.toLowerCase().trim()
  return SPORTS_PATTERNS.some(pattern => lower.includes(pattern))
}

async function fetchActiveDomain(logger: Logger): Promise<string | null> {
  try {
    logger.info('Fetching https://daddylive.org/ ...')
    const response = await axios.get('https://daddylive.org/', {
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    const html: string = response.data

    const sectionHeader = 'DaddyLive - DaddyLiveHD Live Sports Stream Online Free HD'
    const sectionIdx = html.indexOf(sectionHeader)
    if (sectionIdx === -1) {
      logger.error('Could not find DaddyLiveHD section on the page')
      return null
    }

    const sections = ['WarFlix - Movies', 'DaddyLive Telegram', 'Discord']
    let endIdx = html.length
    for (const sec of sections) {
      const idx = html.indexOf(sec, sectionIdx + sectionHeader.length)
      if (idx !== -1 && idx < endIdx) endIdx = idx
    }
    const sectionContent = html.slice(sectionIdx, endIdx)

    // Find Active domains
    let searchStart = 0
    while (true) {
      const activeIdx = sectionContent.indexOf('Active', searchStart)
      if (activeIdx === -1) break
      const contextStart = Math.max(0, activeIdx - 400)
      const contextEnd = Math.min(sectionContent.length, activeIdx + 150)
      const context = sectionContent.slice(contextStart, contextEnd)
      if (context.match(/Domain\s*-\s*\d+/i)) {
        const urlMatch = context.match(
          /https?:\/\/(?:daddylive|streameast|dlhd)[a-zA-Z0-9.-]+\.[a-z]+/
        )
        if (urlMatch) return urlMatch[0].replace(/\/+$/, '')
      }
      searchStart = activeIdx + 6
    }

    // Fallback regex
    const fallbackMatch = sectionContent.match(
      /Domain\s*-\s*\d+[\s\S]{0,500}?Active[\s\S]{0,200}?(https?:\/\/[^\s<>"']+)/i
    )
    if (fallbackMatch) {
      const url = fallbackMatch[1].replace(/\/+$/, '')
      if (url.match(/daddylive|streameast|dlhd/)) return url
    }
  } catch (err: any) {
    logger.error(`Failed to scrape daddylive domains: ${err.message || err}`)
  }
  return null
}

async function fetchPlayerData(
  domain: string,
  playerVar: string,
  logger: Logger
): Promise<PlayerEntry[]> {
  try {
    const url = `${domain}/embed/embed.php?id=32&player=1&source=tv.json`
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    const html: string = response.data
    const match = html.match(
      new RegExp(`const\\s+${playerVar}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;`)
    )
    if (!match) {
      logger.warn(`Could not find ${playerVar} in the embed page`)
      return []
    }
    const entries: PlayerEntry[] = JSON.parse(match[1])
    logger.info(`Parsed ${entries.length} entries from ${playerVar}`)
    return entries
  } catch (err: any) {
    logger.warn(`Failed to fetch ${playerVar}: ${err.message || err}`)
    return []
  }
}

function findMatch(data: PlayerEntry[], title: string): PlayerEntry | null {
  if (!Array.isArray(data) || !title) return null

  // Normalize once
  function norm(s: string): string {
    return s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ')
  }

  const n = norm(title)

  // 1. Exact name match
  for (const c of data) {
    if (c.name && norm(c.name) === n) return c
  }

  // 2. startsWith
  for (const c of data) {
    if (!c.name) continue
    const h = norm(c.name)
    if (n.startsWith(h) || h.startsWith(n)) return c
  }

  // 3. Word containment
  const words = n.split(' ').filter(x => x.length > 1)
  if (words.length) {
    for (const c of data) {
      if (!c.name) continue
      const h = norm(c.name)
      if (words.every(w => h.includes(w))) return c
    }
  }

  return null
}

// Browser-based extraction: loads the embed page in a headless Chromium
// and intercepts network requests to capture the actual m3u8 stream URL.
let browserInstance: import('playwright').Browser | null = null

async function getBrowser(): Promise<import('playwright').Browser> {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
  }
  return browserInstance
}

async function extractStreamWithBrowser(
  embedUrl: string,
  logger: Logger
): Promise<string | null> {
  const browser = await getBrowser()
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  })

  const m3u8Urls: string[] = []

  // Intercept all network responses to capture m3u8 URLs
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = request.url()
    if (url.includes('.m3u8') || url.includes('.mpd')) {
      m3u8Urls.push(url)
    }
    // Also check redirect chain
    const redirectChain = request.redirectedFrom()
    if (redirectChain) {
      let r = redirectChain
      while (r) {
        if (r.url().includes('.m3u8')) m3u8Urls.push(r.url())
        r = r.redirectedFrom()
      }
    }
    await route.continue()
  })

  // Intercept responses to check for m3u8 URLs in redirects
  context.on('response', (response) => {
    const url = response.url()
    if (url.includes('.m3u8')) {
      m3u8Urls.push(url)
    }
  })

  try {
    const page = await context.newPage()

    // Navigate and wait for network to settle
    await page.goto(embedUrl, {
      waitUntil: 'networkidle',
      timeout: 20000
    }).catch(() => {})

    // Give extra time for delayed player initialization
    await page.waitForTimeout(5000)

    // Check page for video/iframe sources
    const pageM3u8 = await page.evaluate(() => {
      const found: string[] = []
      // Check video elements
      document.querySelectorAll('video').forEach(v => {
        if (v.src && v.src.includes('.m3u8')) found.push(v.src)
        v.querySelectorAll('source').forEach(s => {
          if (s.src && s.src.includes('.m3u8')) found.push(s.src)
        })
      })
      // Check iframes
      document.querySelectorAll('iframe').forEach(iframe => {
        if (iframe.src && iframe.src.includes('.m3u8')) found.push(iframe.src)
      })
      return found
    })
    m3u8Urls.push(...pageM3u8)

    // Deduplicate and return the first valid URL
    const unique = [...new Set(m3u8Urls)]
    if (unique.length > 0) return unique[0]

  } catch {
    return null
  } finally {
    await context.close()
  }

  return null
}

async function extractStreamFromEventEmbed(
  embedUrl: string,
  player9Data: PlayerEntry[],
  logger: Logger
): Promise<string | null> {
  try {
    const response = await axios.get(embedUrl, {
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    const html: string = response.data

    // Extract channel_id
    const cidMatch = html.match(/const\s+channel_id\s*=\s*"([^"]+)"/)
    if (!cidMatch) return null
    const channelId = cidMatch[1].replace(/\\\//g, '/')

    // Check if source=tv.json (standard channel) or not (event link)
    const hasTvSource = embedUrl.includes('source=tv.json')

    let title: string
    if (hasTvSource) {
      const cdMatch = html.match(
        /(?:var|let|const)\s+channelData\s*=\s*(\[[\s\S]*?\])\s*;/
      )
      if (cdMatch) {
        try {
          const channelData = JSON.parse(cdMatch[1])
          const entry = channelData.find(
            (c: any) => String(c.id) === String(channelId)
          )
          title = entry?.title || channelId.replace(/-/g, ' ')
        } catch {
          title = channelId.replace(/-/g, ' ')
        }
      } else {
        title = channelId.replace(/-/g, ' ')
      }
    } else {
      title = channelId.replace(/-/g, ' ')
    }

    // Try findMatch against player9Data first (works for standard TV channels)
    const match = findMatch(player9Data, title)
    if (match?.url) return match.url

    // For event-specific links, try headless browser
    if (!hasTvSource) {
      logger.info(`  launching browser for ${embedUrl.substring(0, 80)}...`)
      const browserUrl = await extractStreamWithBrowser(embedUrl, logger)
      if (browserUrl) return browserUrl
    }

    // Fallback: try dlhd sources via HTTP
    const linkOrderMatch = html.match(
      /const\s+playerLinksOrder\s*=\s*(\[[\s\S]*?\])\s*;/
    )
    if (linkOrderMatch) {
      const linkOrder: string[] = JSON.parse(linkOrderMatch[1])
      for (const sourceId of linkOrder) {
        if (sourceId.startsWith('dlhd')) {
          const num = sourceId.replace('dlhd', '')
          const dlhdUrls: Record<string, string> = {
            '1': 'https://cricsfree.cfd/live/stream-',
            '2': 'https://dlhd.pk/cast/stream-',
            '3': 'https://dlhd.pk/watch/stream-',
            '4': 'https://dlhd.pk/plus/stream-',
            '5': 'https://dlhd.pk/player/stream-',
            '10': 'https://dlhd.pk/casting/stream-',
          }
          const baseUrl = dlhdUrls[num]
          if (baseUrl) {
            const dlhdUrl = `${baseUrl}${channelId}.php`
            try {
              const dlhdResp = await axios.get(dlhdUrl, {
                timeout: 10000,
                maxRedirects: 10,
                headers: {
                  'User-Agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
              })
              const m3u8Match = dlhdResp.data.match(
                /https?:\/\/[^\s"']+\.m3u8[^\s"']*/
              )
              if (m3u8Match) return m3u8Match[0]
              if (
                dlhdResp.request?.res?.responseUrl?.includes('.m3u8')
              ) {
                return dlhdResp.request.res.responseUrl
              }
            } catch {
              // dlhd source failed, continue
            }
          }
        }
      }
    }

    return null
  } catch {
    return null
  }
}

async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close()
    browserInstance = null
  }
}

async function fetchEvents(
  domain: string,
  logger: Logger
): Promise<{ channels: EventChannel[] }> {
  const allChannels: EventChannel[] = []

  try {
    const url = `${domain}/api/events`
    logger.info(`Fetching sports events from ${url} ...`)
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    const days: DayData[] = response.data

    for (const day of days) {
      const categories = day.categories || {}
      for (const [categoryName, events] of Object.entries(categories)) {
        const lowerCat = categoryName.toLowerCase().trim()
        const isInteresting = EVENTS_INTERESTING_CATEGORIES.some(
          cat => lowerCat.includes(cat) || cat.includes(lowerCat)
        )
        if (!isInteresting) continue
        if (!Array.isArray(events)) continue

        for (const event of events) {
          if (!event.channels || !Array.isArray(event.channels)) continue
          const eventName = event.event || ''
          for (const channel of event.channels) {
            allChannels.push({
              ...channel,
              eventName
            })
          }
        }
      }
    }

    logger.info(`Found ${allChannels.length} channels from interesting event categories`)
  } catch (err: any) {
    logger.error(`Failed to fetch events: ${err.message || err}`)
  }

  return { channels: allChannels }
}

export async function scrapeDaddylive(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  // Step 1: Find active domain
  logger.info('=== Step 1: Finding active daddylive domain ===')
  const domain = await fetchActiveDomain(logger)
  if (!domain) {
    logger.error('No active daddylive domain found')
    return result
  }
  logger.info(`Using domain: ${domain}`)

  // Step 2: Fetch player data arrays
  logger.info('=== Step 2: Fetching player data arrays ===')
  const player9Data = await fetchPlayerData(domain, 'player9Data', logger)
  if (player9Data.length === 0) {
    logger.error('No player9Data found')
    return result
  }

  // Step 3: Extract sports channels directly from player9Data
  logger.info('=== Step 3: Extracting sports channels from player9Data ===')
  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  let sportsCount = 0
  for (const entry of player9Data) {
    if (!entry.name || !entry.url) continue
    if (!entry.url.includes('.m3u8')) continue
    if (!isSportsChannel(entry.name)) continue
    if (seenUrls.has(entry.url)) continue
    seenUrls.add(entry.url)

    const stream = new Stream({
      channel: null,
      feed: null,
      title: entry.name,
      url: entry.url,
      quality: null,
      referrer: null,
      user_agent: null,
      label: null
    })
    stream.tvgId = entry.name
    stream.tvgLogo = ''
    stream.groupTitle = GROUP_TITLE
    streams.push(stream)
    sportsCount++
  }
  logger.info(`Added ${sportsCount} sports channels from player9Data`)

  // Step 4: Fetch events API for additional channels
  logger.info('=== Step 4: Fetching events for additional channels ===')
  const { channels: eventChannels } = await fetchEvents(domain, logger)

  if (eventChannels.length > 0) {
    let eventMatched = 0
    for (const channel of eventChannels) {
      const channelName = channel.channel_name || ''
      const hasRealName =
        channelName && !channelName.match(/^Link\s*-\s*\d+$/i)

      const eventName = channel.eventName || ''
      const liveTitle = eventName ? `${eventName} - ${channelName}` : channelName

      if (hasRealName) {
        // Standard channel with a real name - use findMatch against player9Data
        const match = findMatch(player9Data, channelName)
        if (match?.url && !seenUrls.has(match.url)) {
          seenUrls.add(match.url)
          const stream = new Stream({
            channel: null,
            feed: null,
            title: liveTitle,
            url: match.url,
            quality: null,
            referrer: null,
            user_agent: null,
            label: null
          })
          stream.tvgId = channelName
          stream.tvgLogo = ''
          stream.groupTitle = GROUP_TITLE
          streams.push(stream)
          eventMatched++
        }
      } else if (channel.url) {
        // Event-specific link - try to extract stream from embed page
        const m3u8Url = await extractStreamFromEventEmbed(
          channel.url,
          player9Data,
          logger
        )
        if (m3u8Url && !seenUrls.has(m3u8Url)) {
          seenUrls.add(m3u8Url)
          const stream = new Stream({
            channel: null,
            feed: null,
            title: liveTitle,
            url: m3u8Url,
            quality: null,
            referrer: null,
            user_agent: null,
            label: null
          })
          stream.tvgId = channelName
          stream.tvgLogo = ''
          stream.groupTitle = GROUP_TITLE
          streams.push(stream)
          eventMatched++
        }
      }
    }
    logger.info(`Matched ${eventMatched} additional channels from events API`)
  }

  logger.info(
    `Total DaddyLive streams: ${streams.length}`
  )

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  // Close headless browser if it was opened
  await closeBrowser()

  return result
}
