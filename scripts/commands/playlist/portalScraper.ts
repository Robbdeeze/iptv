import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { createStream } from '../../core/aggregatorHelpers'
import axios from 'axios'
import { eachLimit } from 'async'

const VERIFY_TIMEOUT = 8000
const FETCH_TIMEOUT = 15000
const MAX_VERIFIED = 20
const MAX_STREAMS_PER_PORTAL = 500

const UA = 'Mozilla/5.0 (Linux; Android 11; PlayTorrio) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

const CATALOG_SUBS = ['IPTV_ZONENEW']

const URL_PARAM = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(?:username|user)=([^&\s"'<]+)\s*&(?:password|pass)=([^&\s"'<]+)/gi
const LABEL = /(?:Portal|Host(?:\s*URL)?|Panel|Real|URL|🔗)\W*?(https?:\/\/[^<\s"']+)[\s\S]{1,500}?(?:Username|User|Usu[áa]rio|Usuario|👤)\W*?([^\s|<"'\n]+)[\s\S]{1,200}?(?:Password|Pass|Senha|Contrase[ñn]a|🔑)\W*?([^\s|<"'\n]+)/gi

const JUNK_TOKENS = ['Array.isArray', 'prototype.', 'function(']

const B64 = /aHR0c[a-zA-Z0-9+/=]{10,}/g
const PASTE_DOMAINS = ['paste.sh', 'pastebin.com', 'justpaste.it', 'controlc.com', 'pastes.dev', 'text.is', 'rentry.co']
const RAW_PASTE = new RegExp('https?://(?:' + PASTE_DOMAINS.join('|') + ')/[a-zA-Z0-9#_=-]+', 'gi')

interface Portal {
  url: string
  username: string
  password: string
  source: string
}

interface VerifiedPortal {
  portal: Portal
  name: string
}



function isJunk(text: string): boolean {
  let hits = 0
  for (const t of JUNK_TOKENS) {
    if (text.includes(t)) hits++
    if (hits >= 2) return true
  }
  return false
}

function cleanPortalUrl(raw: string): string {
  let clean = raw.replace(/\s+/g, '')
  const qIdx = clean.indexOf('?')
  if (qIdx >= 0) clean = clean.substring(0, qIdx)
  clean = clean.replace(/\/+(?:get|live|portal|c|index|playlist|player_api|xmltv|index\.php|portal\.php)\.php$/i, '')
  while (clean.endsWith('/')) clean = clean.substring(0, clean.length - 1)
  if (!clean.startsWith('http')) clean = 'http://' + clean
  return clean
}

function cleanCred(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('=')) s = s.substring(1).trim()
  s = s.split(/[\s&?]/)[0]
  return s
}

function extractPortals(text: string, source: string): Portal[] {
  if (text.length < 15 || isJunk(text)) return []

  const cleaned = text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/<(?:p|br|div|li|h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  const seen = new Set<string>()
  const portals: Portal[] = []

  function add(rawUrl: string, rawUser: string, rawPass: string) {
    const url = cleanPortalUrl(rawUrl)
    const user = cleanCred(rawUser)
    const pass = cleanCred(rawPass)
    if (!url || user.length < 3 || pass.length < 3) return
    if (user.includes('http') || pass.includes('http')) return
    const lu = user.toLowerCase()
    const lp = pass.toLowerCase()
    for (const j of JUNK_TOKENS) {
      if (lu.includes(j) || lp.includes(j)) return
    }
    const key = `${url}|${user}|${pass}`
    if (seen.has(key)) return
    seen.add(key)
    portals.push({ url, username: user, password: pass, source })
  }

  let m: RegExpExecArray | null
  URL_PARAM.lastIndex = 0
  while ((m = URL_PARAM.exec(cleaned)) !== null) {
    add(m[1], m[2], m[3])
  }
  LABEL.lastIndex = 0
  while ((m = LABEL.exec(cleaned)) !== null) {
    add(m[1], m[2], m[3])
  }

  return portals
}

async function fetchPasteContent(url: string): Promise<string | null> {
  try {
    if (url.includes('paste.sh'))
      return null // paste.sh uses AES-256-CBC decryption, skip
    if (url.includes('pastebin.com/') && !url.includes('/raw/')) {
      const id = url.replace(/.*pastebin\.com\//, '').split(/[?#]/)[0]
      return await axios.get(`https://pastebin.com/raw/${id}`, { timeout: 10000, headers: { 'User-Agent': UA } }).then(r => r.data)
    }
    if (url.includes('pastes.dev/')) {
      const id = url.replace(/.*pastes\.dev\//, '').split(/[?#]/)[0]
      return await axios.get(`https://api.pastes.dev/${id}`, { timeout: 10000, headers: { 'User-Agent': UA } }).then(r => r.data)
    }
    if (url.includes('rentry.co/') && !url.includes('/raw')) {
      const id = url.replace(/.*rentry\.co\//, '').split(/[?#]/)[0]
      return await axios.get(`https://rentry.co/${id}/raw`, { timeout: 10000, headers: { 'User-Agent': UA } }).then(r => r.data)
    }
    return await axios.get(url, { timeout: 10000, headers: { 'User-Agent': UA } }).then(r => r.data)
  } catch {
    return null
  }
}

async function fetchRedditPortals(logger: Logger): Promise<Portal[]> {
  const portals: Portal[] = []
  const seenPastes = new Set<string>()

  for (const sub of CATALOG_SUBS) {
    try {
      logger.info(`  fetching r/${sub}...`)
      const res = await axios.get(`https://www.reddit.com/r/${sub}/new/.json?limit=100&sort=new`, {
        headers: { 'User-Agent': UA },
        timeout: 15000,
      })
      const data: any = res.data
      const posts: any[] = data?.data?.children || []

      for (const post of posts) {
        const pdata = post?.data
        if (!pdata) continue
        const title = pdata.title?.toString() || ''
        const body = `${title} ${pdata.selftext?.toString() || ''}`.trim()
        portals.push(...extractPortals(body, `reddit:${sub}`))

        const deepLinks = new Set<string>()
        for (const bm of body.match(B64) || []) {
          try {
            const decoded = Buffer.from(bm, 'base64').toString('utf-8')
            if (decoded.startsWith('http') && PASTE_DOMAINS.some(d => decoded.includes(d))) {
              deepLinks.add(decoded)
            } else if (!decoded.startsWith('http') && decoded.includes(':')) {
              portals.push(...extractPortals(decoded, `reddit/b64:${sub}`))
            }
          } catch { }
        }
        for (const pm of body.match(RAW_PASTE) || []) {
          deepLinks.add(pm)
        }

        let dlCount = 0
        for (const dl of deepLinks) {
          if (dlCount >= 4) break
          const pk = dl.replace(/\/+$/, '').toLowerCase()
          if (seenPastes.has(pk)) continue
          seenPastes.add(pk)
          dlCount++
          const text = await fetchPasteContent(dl)
          if (text) portals.push(...extractPortals(text, `reddit/deep:${sub}`))
        }
      }
    } catch (err: any) {
      logger.warn(`  Reddit r/${sub} failed: ${err.message?.substring(0, 60) || err}`)
    }
  }

  return portals
}

async function fetchGitHubPortals(logger: Logger): Promise<Portal[]> {
  let files: { url: string; name: string }[] = []

  try {
    const res = await axios.get('https://api.github.com/repos/akeotaseo/world_repo/contents/Updater_Matrix/XML2?ref=main', {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      timeout: 15000,
    })
    const entries: any[] = res.data
    files = entries
      .filter((e: any) => e.type === 'file' && /\.txt$/i.test(e.name) && e.download_url)
      .sort((a: any, b: any) => (a.size || 0) - (b.size || 0))
      .map((e: any) => ({ url: e.download_url, name: e.name }))
    logger.info(`  listed ${files.length} XML2 files from GitHub`)
  } catch (err: any) {
    logger.warn(`  GitHub API failed: ${err.message?.substring(0, 60) || err}, using fallback`)
    const base = 'https://raw.githubusercontent.com/akeotaseo/world_repo/main/Updater_Matrix/XML2/'
    files = [
      '25.txt', '71.txt', 'ABN.txt', 'DOV.txt',
      '%5BK_B_W_%20Client%5D.txt', 'br.txt',
      'channels_fulltime%20(OR).txt', 'channels_fulltime.txt',
      'kgen%20(4).txt', 'kgen.txt', 'rg.txt', 'x.txt',
      '%7BAllTelegram%7D2.txt',
    ].map(n => ({ url: base + n, name: n }))
  }

  const portals: Portal[] = []
  const seen = new Set<string>()

  for (const file of files) {
    try {
      const res = await axios.get(file.url, { timeout: 15000, headers: { 'User-Agent': UA } })
      const found = extractPortals(res.data, `github/xml2:${file.name}`)
      for (const p of found) {
        const key = `${p.url}|${p.username}|${p.password}`
        if (seen.has(key)) continue
        seen.add(key)
        portals.push(p)
      }
    } catch { }
  }

  return portals
}

async function verifyPortal(p: Portal): Promise<VerifiedPortal | null> {
  try {
    const url = `${p.url}/player_api.php?username=${encodeURIComponent(p.username)}&password=${encodeURIComponent(p.password)}`
    const res = await axios.get(url, {
      timeout: VERIFY_TIMEOUT,
      headers: { 'User-Agent': 'VLC/3.0.20', Accept: 'application/json,*/*' },
      validateStatus: () => true,
    })
    if (res.status < 200 || res.status >= 300) return null
    const data = res.data
    if (!data || typeof data !== 'object') return null
    const info = data.user_info || data
    const auth = String(info.auth || '')
    const status = (info.status || '').toString().toLowerCase()
    if (auth !== '1' && status !== 'active' && !data.user_info) return null
    const name = (info.username || p.username).toString()
    return { portal: p, name }
  } catch {
    return null
  }
}

async function fetchPortalStreams(p: VerifiedPortal, logger: Logger): Promise<Stream[]> {
  try {
    const url = `${p.portal.url}/player_api.php?username=${encodeURIComponent(p.portal.username)}&password=${encodeURIComponent(p.portal.password)}&action=get_live_streams`
    const res = await axios.get(url, {
      timeout: FETCH_TIMEOUT,
      headers: { 'User-Agent': 'VLC/3.0.20', Accept: 'application/json,*/*' },
    })
    const streams: any[] = res.data
    if (!Array.isArray(streams)) return []

    const groupTitle = `! Portals - ${p.name}`
    const user = encodeURIComponent(p.portal.username)
    const pass = encodeURIComponent(p.portal.password)
    const base = p.portal.url.replace(/\/+$/, '')
    const out: Stream[] = []
    let count = 0

    for (const s of streams) {
      if (count >= MAX_STREAMS_PER_PORTAL) break
      const streamId = s.stream_id?.toString() || s.id?.toString() || ''
      const name = s.name?.toString() || s.title?.toString() || ''
      if (!streamId || !name) continue
      const icon = s.stream_icon?.toString() || ''
      const ext = s.container_extension?.toString() || 'ts'
      const streamUrl = `${base}/live/${user}/${pass}/${streamId}.${ext}`
      const tvgId = s.epg_channel_id?.toString() || `${p.name}:${streamId}`
      const stream = new Stream({
        channel: tvgId,
        title: name,
        url: streamUrl,
        quality: null,
        referrer: null,
        user_agent: null,
        label: null,
        feed: null,
      })
      stream.tvgId = tvgId
      stream.tvgLogo = icon
      stream.groupTitle = groupTitle
      out.push(stream)
      count++
    }

    return out
  } catch {
    return []
  }
}

export async function scrapePortals(logger: Logger): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== Portal Scraper ===')

  logger.info('Fetching portal credentials from GitHub XML2...')
  const gitPortals = await fetchGitHubPortals(logger)
  logger.info(`Found ${gitPortals.length} raw portals from GitHub XML2`)

  logger.info('Fetching portal credentials from Reddit...')
  const redditPortals = await fetchRedditPortals(logger)
  logger.info(`Found ${redditPortals.length} raw portals from Reddit`)

  const deduped = new Map<string, Portal>()
  for (const p of [...gitPortals, ...redditPortals]) {
    const key = `${p.url}|${p.username}|${p.password}`.toLowerCase()
    if (!deduped.has(key)) deduped.set(key, p)
  }

  const allPortals = [...deduped.values()]
  logger.info(`Total unique raw portals: ${allPortals.length}`)

  if (allPortals.length === 0) return result

  logger.info(`Verifying up to ${Math.min(allPortals.length, MAX_VERIFIED * 3)} portals (will keep ${MAX_VERIFIED} verified)...`)
  const verified: VerifiedPortal[] = []

  await eachLimit(allPortals, 10, async (portal) => {
    if (verified.length >= MAX_VERIFIED) return
    const vp = await verifyPortal(portal)
    if (vp) {
      verified.push(vp)
      logger.info(`  Verified: ${vp.name} @ ${portal.url.substring(0, 50)}...`)
    }
  })

  logger.info(`Verified ${verified.length} portals`)

  if (verified.length === 0) return result

  logger.info(`Fetching live streams from ${verified.length} verified portals...`)

  await eachLimit(verified, 3, async (vp) => {
    const streams = await fetchPortalStreams(vp, logger)
    if (streams.length > 0) {
      const groupTitle = `! Portals - ${vp.name}`
      result.push({ groupTitle, streams })
      logger.info(`  ${vp.name}: ${streams.length} live streams`)
    }
  })

  return result
}
