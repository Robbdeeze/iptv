import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { createStream } from '../../core/aggregatorHelpers'
import axios from 'axios'

const LIVE_URL = 'https://super.league.st'
const CHANNELS_API = 'https://one.sporthd.me'

async function fetchEvents(logger: Logger): Promise<any[]> {
  try {
    const res = await axios.get(LIVE_URL, { timeout: 15000 })
    const html: string = res.data

    const newMatch = html.match(/window\.matches\s*=\s*JSON\.parse\(`(\[.+?\])`\)/)
    if (newMatch) {
      return JSON.parse(newMatch[1])
    }

    const oldPattern = /"matches"\s*:\s*(\[.+?])}]]}]n/
    const oldMatch = html.replace(/,false/g, '').match(oldPattern)
    if (oldMatch) {
      return JSON.parse(oldMatch[1])
    }

    return []
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`SportsHD events fetch error: ${msg}`)
    return []
  }
}

async function fetchChannels(logger: Logger): Promise<any[]> {
  try {
    const url = CHANNELS_API + '/api/trpc/mutual.getTopTeams,saves.getAllUserSaves,mutual.getFooterData,mutual.getAllChannels,mutual.getWebsiteConfig?batch=1&input={"0":{"json":null,"meta":{"values":["undefined"]}},"1":{"json":null,"meta":{"values":["undefined"]}},"2":{"json":null,"meta":{"values":["undefined"]}},"3":{"json":null,"meta":{"values":["undefined"]}},"4":{"json":null,"meta":{"values":["undefined"]}}}'
    const res = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      }
    })
    const data: any[] = res.data
    for (const entry of data) {
      const ac = entry?.result?.data?.json?.allChannels
      if (ac) return ac
    }
    return []
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`SportsHD channels fetch error: ${msg}`)
    return []
  }
}

function detectSport(title: string, league?: string): string {
  const lower = (title + ' ' + (league || '')).toLowerCase()
  if (lower.includes('nfl') || lower.includes('football')) return 'NFL'
  if (lower.includes('nba') || lower.includes('basketball')) return 'NBA'
  if (lower.includes('nhl') || lower.includes('hockey')) return 'NHL'
  if (lower.includes('mlb') || lower.includes('baseball')) return 'MLB'
  if (lower.includes('ufc') || lower.includes('boxing') || lower.includes('fighting')) return 'UFC/Boxing'
  if (lower.includes('soccer') || lower.includes('futbol') || lower.includes('epl') || lower.includes('premier league') || lower.includes('champions league') || lower.includes('la liga') || lower.includes('serie a') || lower.includes('bundesliga') || lower.includes('ligue 1')) return 'Soccer'
  if (lower.includes('tennis') || lower.includes('atp') || lower.includes('wta') || lower.includes('grand slam')) return 'Tennis'
  if (lower.includes('f1') || lower.includes('formula') || lower.includes('nascar') || lower.includes('motogp') || lower.includes('motorsport')) return 'Motorsports'
  if (lower.includes('golf') || lower.includes('pga')) return 'Golf'
  if (lower.includes('ncaa') || lower.includes('college')) return 'NCAA'
  if (lower.includes('wrestling') || lower.includes('wwe') || lower.includes('aew')) return 'Wrestling'
  if (lower.includes('cricket')) return 'Cricket'
  if (lower.includes('darts')) return 'Darts'
  if (lower.includes('rugby')) return 'Rugby'
  if (lower.includes('mls')) return 'MLS'
  if (lower.includes('nll') || lower.includes('lacrosse')) return 'Lacrosse'
  if (lower.includes('afl')) return 'AFL'
  return 'Other'
}

async function resolveStreamUrl(url: string): Promise<string | null> {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

  try {
    const parsed = new URL(url)
    const referer = `${parsed.protocol}//${parsed.host}/`

    if (url.includes('glisco') || url.includes('sansat') || url.includes('vertex') || url.includes('nexa')) {
      const id = url.split('id=').pop()
      if (id) {
        const playerRes = await axios.get(referer + 'api/player.php?id=' + id, {
          timeout: 10000,
          headers: { 'User-Agent': ua, Referer: url }
        })
        const playerData: any = playerRes.data
        const frameUrl = typeof playerData === 'string' ? JSON.parse(playerData).url : playerData.url
        if (!frameUrl) return null

        const cfgUrl = frameUrl + (frameUrl.includes('?') ? '&' : '?') + 'ppcfg=1'
        const cfgRes = await axios.get(cfgUrl, {
          timeout: 10000,
          headers: { 'User-Agent': ua, Referer: url }
        })
        const cfg: any = cfgRes.data
        const src = cfg.src || cfg.srcBase
        if (src) return src
      }
    }

    if (url.includes('dabac')) {
      const id = url.split('id=').pop()
      if (id) {
        const nurl = referer + 'api/player.php?id=' + id
        const playerRes = await axios.get(nurl, { timeout: 10000, headers: { 'User-Agent': ua } })
        const playerData: any = playerRes.data
        const iframeUrl = typeof playerData === 'string' ? JSON.parse(playerData).url : playerData.url
        if (!iframeUrl) return null

        const iframeRes = await axios.get(iframeUrl, { timeout: 10000, headers: { 'User-Agent': ua, Referer: url } })
        const iframeHtml: string = iframeRes.data
        const b64Match = iframeHtml.match(/id="crf__"\s+value=['"]([^'"]+)/)
        if (b64Match) {
          const decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8')
          if (decoded.startsWith('http')) return decoded
        }
      }
    }

    return null
  } catch {
    return null
  }
}

export async function scrapeSportsHD(logger: Logger): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== SportsHD Scraper ===')

  const events = await fetchEvents(logger)
  logger.info(`Found ${events.length} events on SportsHD`)

  const channels = await fetchChannels(logger)
  logger.info(`Found ${channels.length} 24/7 channels`)

  const seenUrls = new Set<string>()
  const grouped = new Map<string, Stream[]>()

  const maxEvents = 50
  let count = 0

  for (const match of events) {
    if (count >= maxEvents) break

    const team1 = match.team1 || ''
    const team2 = match.team2 || ''
    const sport = match.sport || ''
    const league = match.league || ''
    const eventName = team1 && team2 ? `${team1} vs ${team2}` : (team1 || sport || league)

    const channelsList: any[] = match.channels || []
    if (channelsList.length === 0) continue

    const sportCategory = detectSport(`${team1} ${team2} ${sport}`, league)
    const groupTitle = `! Sports - SportsHD - ${sportCategory}`
    if (!grouped.has(groupTitle)) grouped.set(groupTitle, [])

    for (const ch of channelsList) {
      if (count >= maxEvents) break

      const links: string[] = ch.links || []
      if (links.length === 0) continue

      const chName = ch.name || ''

      for (const link of links) {
        if (seenUrls.has(link)) continue
        seenUrls.add(link)

        let resolvedUrl = link
        if (!link.includes('.m3u8')) {
          logger.info(`[${count + 1}/${maxEvents}] Resolving: ${eventName} - ${chName} (${sportCategory})`)
          const r = await resolveStreamUrl(link)
          if (r) {
            resolvedUrl = r
          } else {
            continue
          }
        }

        count++
        const title = team1 && team2
          ? `${eventName} - ${chName}`
          : `${chName}`

        const streams = grouped.get(groupTitle)!
        streams.push(createStream(title, resolvedUrl, groupTitle))
        logger.info(`  -> ${resolvedUrl.substring(0, 80)}...`)
      }
    }
  }

  for (const ch of channels) {
    if (count >= maxEvents) break

    const chName = ch.channelName || ''
    const lang = ch.language || ''
    const links: string[] = ch.links || []
    if (links.length === 0 || !chName) continue

    const groupTitle = '! Sports - SportsHD - 24/7'
    if (!grouped.has(groupTitle)) grouped.set(groupTitle, [])

    for (const link of links) {
      if (seenUrls.has(link)) continue
      seenUrls.add(link)

      let resolvedUrl = link
      if (!link.includes('.m3u8')) {
        const r = await resolveStreamUrl(link)
        if (r) resolvedUrl = r
        else continue
      }

      count++
      const title = `${chName}${lang ? ` (${lang})` : ''}`
      const streams = grouped.get(groupTitle)!
      streams.push(createStream(title, resolvedUrl, groupTitle))
    }
  }

  for (const [group, streams] of grouped) {
    if (streams.length > 0) {
      logger.info(`${group}: ${streams.length} streams`)
      result.push({ groupTitle: group, streams })
    }
  }

  return result
}
