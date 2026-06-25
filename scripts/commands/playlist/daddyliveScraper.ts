import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import axios from 'axios'

const GROUP_TITLE = 'DaddyLive - Sports'

const SPORTS_CATEGORIES = new Set([
  'soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis',
  'mma', 'boxing', 'rugby', 'cricket', 'motorsports', 'f1', 'motogp',
  'ufc', 'nfl', 'nba', 'nhl', 'mlb', 'wwe', 'wrestling', 'ppv events',
  'horse racing', 'darts', 'snooker', 'golf', 'cycling', 'volleyball',
  'handball', 'olympics', 'racing'
])

const COUNTRY_MAP: Record<string, string> = {
  netherlands: 'nl',
  holland: 'nl',
  'united kingdom': 'uk',
  'great britain': 'uk',
  england: 'uk',
  britain: 'uk',
  'united states': 'us',
  'usa': 'us',
  america: 'us',
  germany: 'de',
  deutschland: 'de',
  france: 'fr',
  spain: 'es',
  españa: 'es',
  italy: 'it',
  italia: 'it',
  portugal: 'pt',
  belgium: 'be',
  belgique: 'be',
  switzerland: 'ch',
  schweiz: 'ch',
  austria: 'at',
  Österreich: 'at',
  poland: 'pl',
  polska: 'pl',
  russia: 'ru',
  turkey: 'tr',
  türkiye: 'tr',
  brazil: 'br',
  brasil: 'br',
  argentina: 'ar',
  japan: 'jp',
  china: 'cn',
  australia: 'au',
  canada: 'ca',
  mexico: 'mx',
  colombia: 'co',
  chile: 'cl',
  peru: 'pe',
  ecuador: 'ec',
  uruguay: 'uy',
  paraguay: 'py',
  bolivia: 'bo',
  venezuela: 've',
  'costa rica': 'cr',
  panama: 'pa',
  honduras: 'hn',
  guatemala: 'gt',
  'el salvador': 'sv',
  nicaragua: 'ni',
  cuba: 'cu',
  'dominican republic': 'do',
  'puerto rico': 'pr',
  ireland: 'ie',
  eire: 'ie',
  scotland: 'sct',
  wales: 'wls',
  'northern ireland': 'nir',
  denmark: 'dk',
  danmark: 'dk',
  sweden: 'se',
  sverige: 'se',
  norway: 'no',
  norge: 'no',
  finland: 'fi',
  suomi: 'fi',
  iceland: 'is',
  Ísland: 'is',
  greece: 'gr',
  Ελλάδα: 'gr',
  croatia: 'hr',
  hrvatska: 'hr',
  serbia: 'rs',
  srbija: 'rs',
  romania: 'ro',
  românia: 'ro',
  bulgaria: 'bg',
  България: 'bg',
  hungary: 'hu',
  magyarország: 'hu',
  'czech republic': 'cz',
  czechia: 'cz',
  Česko: 'cz',
  slovakia: 'sk',
  slovenia: 'si',
  bosnia: 'ba',
  herzegovina: 'ba',
  albania: 'al',
  macedonia: 'mk',
  montenegro: 'me',
  ukraine: 'ua',
  belarus: 'by',
  lithuania: 'lt',
  latvia: 'lv',
  estonia: 'ee',
  georgia: 'ge',
  armenia: 'am',
  azerbaijan: 'az',
  israel: 'il',
  'saudi arabia': 'sa',
  qatar: 'qa',
  uae: 'ae',
  'united arab emirates': 'ae',
  india: 'in',
  bharat: 'in',
  pakistan: 'pk',
  bangladesh: 'bd',
  'sri lanka': 'lk',
  nepal: 'np',
  thailand: 'th',
  vietnam: 'vn',
  indonesia: 'id',
  malaysia: 'my',
  philippines: 'ph',
  singapore: 'sg',
  'hong kong': 'hk',
  taiwan: 'tw',
  'south korea': 'kr',
  korea: 'kr',
  'north korea': 'kp',
  egypt: 'eg',
  morocco: 'ma',
  tunisia: 'tn',
  algeria: 'dz',
  nigeria: 'ng',
  ghana: 'gh',
  senegal: 'sn',
  cameroon: 'cm',
  'ivory coast': 'ci',
  kenya: 'ke',
  'south africa': 'za',
  'new zealand': 'nz',
  'world feed': 'int',
  international: 'int'
}

function normalizeName(name: string): string {
  let normalized = name.toLowerCase().trim()
  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ')
  // Remove special chars except spaces, hyphens, dots, and parentheses
  normalized = normalized.replace(/[^a-z0-9\s\-\.\(\)]/g, '')
  // Normalize country names
  const words = normalized.split(/\s+/)
  const mapped = words.map(word => COUNTRY_MAP[word] || word)
  return mapped.join(' ').trim()
}

function cleanForMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

interface Player9Entry {
  name: string
  url: string
}

interface EventChannel {
  channel_name?: string
  channel_id?: string | number
  url?: string
  source?: string
}

interface EventItem {
  time?: string
  event?: string
  channels?: EventChannel[]
  source?: string
}

interface DayData {
  day?: string
  categories?: Record<string, EventItem[]>
}

async function scrapeActiveDomains(logger: Logger): Promise<string[]> {
  const domains: string[] = []

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

    // Find the section header "DaddyLive - DaddyLiveHD Live Sports Stream Online Free HD"
    const sectionHeader =
      'DaddyLive - DaddyLiveHD Live Sports Stream Online Free HD'
    const sectionIdx = html.indexOf(sectionHeader)
    if (sectionIdx === -1) {
      logger.error('Could not find DaddyLiveHD section on the page')
      return domains
    }

    // Get content from the section to next known section or end
    const sections = ['WarFlix - Movies', 'DaddyLive Telegram', 'Discord']
    let endIdx = html.length
    for (const sec of sections) {
      const idx = html.indexOf(sec, sectionIdx + sectionHeader.length)
      if (idx !== -1 && idx < endIdx) {
        endIdx = idx
      }
    }
    const sectionContent = html.slice(sectionIdx, endIdx)

    // Find "Domain - X" patterns with "Active" status and extract the URL
    // Structure is like: Domain - X <some content> Active <some content> https://...
    // Use a two-pass approach: find all Active spans, then find the nearest preceding/following domain URL

    // Pass 1: Find all occurrences of "Active" in the section
    let searchStart = 0
    while (true) {
      const activeIdx = sectionContent.indexOf('Active', searchStart)
      if (activeIdx === -1) break

      // Get context around this Active marker
      const contextStart = Math.max(0, activeIdx - 400)
      const contextEnd = Math.min(sectionContent.length, activeIdx + 150)
      const context = sectionContent.slice(contextStart, contextEnd)

      // Check if this is in a Domain block (look for "Domain" near the context)
      const domainMatch = context.match(/Domain\s*-\s*\d+/i)
      if (domainMatch) {
        // Extract URL from the context - look for https:// patterns
        const urlMatch = context.match(
          /https?:\/\/(?:daddylive|streameast|dlhd)[a-zA-Z0-9.-]+\.[a-z]+/
        )
        if (urlMatch) {
          const url = urlMatch[0].replace(/\/+$/, '') // trailing slash
          if (!domains.includes(url)) {
            domains.push(url)
            logger.info(`Found active domain: ${url}`)
          }
        }
      }

      searchStart = activeIdx + 6
    }

    // Fallback: if no domains found via "Active", try scanning for Domain blocks
    if (domains.length === 0) {
      const domainBlockRegex =
        /Domain\s*-\s*\d+[\s\S]{0,500}?(Active|Offline)[\s\S]{0,200}?(https?:\/\/[^\s<>"']+)/gi
      let blockMatch: RegExpExecArray | null
      while ((blockMatch = domainBlockRegex.exec(sectionContent)) !== null) {
        if (blockMatch[1] === 'Active') {
          const url = blockMatch[2].replace(/\/+$/, '')
          if (!domains.includes(url)) {
            domains.push(url)
            logger.info(`Found active domain (fallback): ${url}`)
          }
        }
      }
    }
  } catch (err: any) {
    logger.error(`Failed to scrape daddylive domains: ${err.message || err}`)
  }

  return domains
}

async function fetchPlayer9Data(
  domain: string,
  logger: Logger
): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  try {
    const url = `${domain}/embed/embed.php?id=32&player=1&source=tv.json`
    logger.info(`Fetching player9Data from ${url} ...`)
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    const html: string = response.data

    // Extract const player9Data = [...];
    // Use a regex that finds the declaration and captures the array
    const match = html.match(
      /const\s+player9Data\s*=\s*(\[[\s\S]*?\])\s*;/
    )
    if (!match) {
      logger.error('Could not find player9Data in the embed page')
      return map
    }

    let entries: Player9Entry[]
    try {
      entries = JSON.parse(match[1])
    } catch (parseErr: any) {
      logger.error(
        `Failed to parse player9Data JSON: ${parseErr.message || parseErr}`
      )
      return map
    }

    logger.info(`Parsed ${entries.length} entries from player9Data`)

    for (const entry of entries) {
      if (entry.name && entry.url) {
        const normalizedName = normalizeName(entry.name)
        const cleanedName = cleanForMatch(entry.name)

        // Store multiple key variants for matching flexibility
        map.set(entry.name, entry.url)
        map.set(normalizedName, entry.url)
        if (cleanedName !== normalizedName && cleanedName !== entry.name) {
          map.set(cleanedName, entry.url)
        }
      }
    }

    logger.info(`Built lookup map with ${map.size} keys`)
  } catch (err: any) {
    logger.error(
      `Failed to fetch player9Data from ${domain}: ${err.message || err}`
    )
  }

  return map
}

async function fetchSportEvents(
  domain: string,
  logger: Logger
): Promise<EventItem[]> {
  const sportsEvents: EventItem[] = []

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
        // Check if this category is a sports category
        const isSport =
          Array.from(SPORTS_CATEGORIES).some((sport) => {
            if (lowerCat.includes(sport)) return true
            if (sport.includes(lowerCat)) return true
            return false
          }) || false

        if (!isSport) continue

        if (!Array.isArray(events)) continue

        for (const event of events) {
          if (!event.channels || !Array.isArray(event.channels)) continue
          for (const channel of event.channels) {
            if (channel.channel_name) {
              sportsEvents.push({
                time: event.time,
                event: event.event,
                channels: [
                  {
                    channel_name: channel.channel_name,
                    channel_id: channel.channel_id,
                    source: channel.source || event.source
                  }
                ]
              })
            }
          }
        }
      }
    }

    logger.info(`Found ${sportsEvents.length} sport event channels`)
  } catch (err: any) {
    logger.error(
      `Failed to fetch sports events from ${domain}: ${err.message || err}`
    )
  }

  return sportsEvents
}

function matchChannel(
  channelName: string,
  player9Map: Map<string, string>
): string | null {
  const normalized = normalizeName(channelName)
  const cleaned = cleanForMatch(channelName)

  // 1. Exact match (try all key variants)
  if (player9Map.has(channelName)) return player9Map.get(channelName)!
  if (player9Map.has(normalized)) return player9Map.get(normalized)!
  if (player9Map.has(cleaned)) return player9Map.get(cleaned)!

  // 2. Substring / containment match against all keys
  for (const [key, url] of player9Map) {
    const keyNorm = normalizeName(key)
    const keyClean = cleanForMatch(key)

    // Check containment both ways
    if (cleaned.includes(keyClean) || keyClean.includes(cleaned)) return url
    if (normalized.includes(keyNorm) || keyNorm.includes(normalized)) return url
  }

  // 3. Individual word match - if any significant word from the channel
  //    appears in the player key and vice versa, it's a strong candidate
  const normWords = normalized
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !w.endsWith('p') && w !== 'hd' && w !== 'fhd' && w !== 'uhd' && w !== 'k')
  if (normWords.length === 0) return null

  let bestMatch: { url: string; score: number } | null = null
  for (const [key, url] of player9Map) {
    const keyNorm = normalizeName(key)
    const keyWords = keyNorm
      .split(/\s+/)
      .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !w.endsWith('p') && w !== 'hd' && w !== 'fhd' && w !== 'uhd' && w !== 'k')

    if (keyWords.length === 0) continue

    const commonWords = normWords.filter(w => keyWords.some(kw => kw.includes(w) || w.includes(kw)))
    // Also check if any keyWord is in normWords
    const commonReverse = keyWords.filter(kw => normWords.some(w => w.includes(kw) || kw.includes(w)))
    
    const allCommon = new Set([...commonWords, ...commonReverse])
    const score = allCommon.size

    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { url, score }
    }
  }

  if (bestMatch && bestMatch.score >= 1) return bestMatch.url

  return null
}

export async function scrapeDaddylive(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  // Step 1: Scrape active domains
  logger.info('=== Step 1: Scraping active daddylive domains ===')
  const domains = await scrapeActiveDomains(logger)

  if (domains.length === 0) {
    logger.error(
      'No active daddylive domains found. Cannot proceed.'
    )
    return result
  }

  logger.info(`Active domains found: ${domains.join(', ')}`)

  // Step 2: Use the first active domain
  const domain = domains[0].replace(/\/+$/, '')
  logger.info(`Using domain: ${domain}`)

  // Step 3: Fetch player9Data for stream URL mapping
  logger.info('=== Step 2: Fetching player9Data stream map ===')
  const player9Map = await fetchPlayer9Data(domain, logger)

  if (player9Map.size === 0) {
    logger.error('No player9Data entries found. Cannot proceed.')
    return result
  }

  // Step 4: Fetch sports events
  logger.info('=== Step 3: Fetching sports events ===')
  const sportsEvents = await fetchSportEvents(domain, logger)

  if (sportsEvents.length === 0) {
    logger.warn('No sports events found.')
    return result
  }

  // Step 5: Match events to streams
  logger.info('=== Step 4: Matching events to streams ===')
  const streams: Stream[] = []
  const seenUrls = new Set<string>()
  let matchedCount = 0

  for (const event of sportsEvents) {
    if (!event.channels || event.channels.length === 0) continue

    for (const channel of event.channels) {
      const channelName = channel.channel_name || ''
      if (!channelName) continue

      const m3u8Url = matchChannel(channelName, player9Map)
      if (!m3u8Url) continue

      // Deduplicate by URL
      if (seenUrls.has(m3u8Url)) continue
      seenUrls.add(m3u8Url)

      const stream = new Stream({
        channel: null,
        feed: null,
        title: channelName,
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
      matchedCount++
    }
  }

  logger.info(
    `Matched ${matchedCount} event channels to streams (${streams.length} unique)`
  )

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
