import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import axios from 'axios'
import { eachLimit } from 'async'

const VERIFY_TIMEOUT = 8000
const FETCH_TIMEOUT = 15000
const MAX_VERIFIED = 20
const MAX_STREAMS_PER_PORTAL = 500

const UA = 'Mozilla/5.0 (Linux; Android 11; PlayTorrio) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

const CORS_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u: string) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u: string) => `https://api.cors.lol/?url=${encodeURIComponent(u)}`,
]

const GITHUB_PORTAL_REPOS: { owner: string; repo: string; path: string; ref: string; fallbackFiles?: string[] }[] = [
  {
    owner: 'akeotaseo',
    repo: 'world_repo',
    path: 'Updater_Matrix/XML2',
    ref: 'main',
    fallbackFiles: [
      '25.txt', '71.txt', 'ABN.txt', 'DOV.txt',
      '%5BK_B_W_%20Client%5D.txt', 'br.txt',
      'channels_fulltime%20(OR).txt', 'channels_fulltime.txt',
      'kgen%20(4).txt', 'kgen.txt', 'rg.txt', 'x.txt',
      '%7BAllTelegram%7D2.txt',
    ],
  },
  {
    owner: 'Armiiin',
    repo: 'world_repo',
    path: 'Updater_Matrix/XML2',
    ref: 'main',
    fallbackFiles: [
      '25.txt', '71.txt', 'ABN.txt', 'DOV.txt',
      '%5BK_B_W_%20Client%5D.txt', 'br.txt',
      'channels_fulltime%20(OR).txt', 'channels_fulltime.txt',
      'kgen%20(4).txt', 'kgen.txt', 'rg.txt', 'x.txt',
      '%7BAllTelegram%7D2.txt',
    ],
  },
]

const URL_PARAM = /(https?:\/\/[^?\s"'<]+)\?(?:[^\s"'<]*?&)?(?:username|user)=([^&\s"'<]+)\s*&(?:password|pass)=([^&\s"'<]+)/gi
const LABEL = /(?:Portal|Host(?:\s*URL)?|Panel|Real|URL|🔗)\W*?(https?:\/\/[^<\s"']+)[\s\S]{1,500}?(?:Username|User|Usu[áa]rio|Usuario|👤)\W*?([^\s|<"'\n]+)[\s\S]{1,200}?(?:Password|Pass|Senha|Contrase[ñn]a|🔑)\W*?([^\s|<"'\n]+)/gi

const JUNK_TOKENS = ['Array.isArray', 'prototype.', 'function(']

const B64 = /aHR0c[a-zA-Z0-9+/=]{10,}/g
const PASTE_DOMAINS = ['paste.sh', 'pastebin.com', 'justpaste.it', 'controlc.com', 'pastes.dev', 'text.is', 'rentry.co']
const RAW_PASTE = new RegExp('https?://(?:' + PASTE_DOMAINS.join('|') + ')/[a-zA-Z0-9#_=-]+', 'gi')

const ADULT_PENALTY_THRESHOLD = 0.3

const ADULT_CATEGORY_TERMS = [
  'xxx', 'adult', 'porn', 'sex', 'erotic', '18+', '18 plus',
  'onlyfans', 'cam', 'nude', 'naked', 'explicit', 'mature',
  'anal', 'oral', 'hardcore', 'softcore', 'milf',
  'ebony', 'lesbian', 'gay', 'trans', 'tranny', 'shemale',
  'sexo', 'porno', 'erotica', 'adultos',
  'strip', 'striptease', 'fetish', 'bdsm', 'kink',
  'blowjob', 'cumshot', 'facial',
]

const ADULT_STREAM_TERMS = [
  ...ADULT_CATEGORY_TERMS,
  'playboy', 'penthouse', 'hustler', 'brazzers', 'bangbros',
  'naughty america', 'reality kings', 'vixen', 'blacked',
  'pornhub', 'xvideos', 'xhamster', 'xnxx',
  'redtube', 'tube8', 'youporn', 'spankwire',
  'twistys', 'teens', 'mofos', 'team skeet',
  'girlsway', 'girlfriends', 'pure taboo',
  'wicked', 'digital playground', 'elegant angel',
  'evil angel', 'jules jordan', 'battle bang',
  'live cams', 'sex cams', 'adult live',
  'adult channels', 'adult tv', 'xxx channels',
  'hot videos', 'hot sex',
  'teen', 'tits', 'boobs', 'pussy', 'cock', 'dick',
]

interface Portal {
  url: string
  username: string
  password: string
  source: string
}

interface VerifiedPortal {
  portal: Portal
  name: string
  domain: string
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

function isAdultCategory(categoryName: string): boolean {
  const lower = categoryName.toLowerCase().trim()
  if (!lower) return false
  return ADULT_CATEGORY_TERMS.some(term => lower.includes(term))
}

function isAdultStreamName(name: string): boolean {
  const lower = name.toLowerCase().trim()
  if (!lower) return false
  return ADULT_STREAM_TERMS.some(term => lower.includes(term))
}

function hasNonLatinScript(text: string): boolean {
  return /[\u0400-\u04FF\u0500-\u052F]/.test(text) ||    // Cyrillic
    /[\u0600-\u06FF\u0750-\u077F]/.test(text) ||           // Arabic
    /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text) ||           // CJK
    /[\u3040-\u309F\u30A0-\u30FF]/.test(text) ||           // Japanese
    /[\uAC00-\uD7AF]/.test(text) ||                         // Korean
    /[\u0E00-\u0E7F]/.test(text) ||                         // Thai
    /[\u0370-\u03FF]/.test(text) ||                         // Greek
    /[\u0590-\u05FF]/.test(text) ||                         // Hebrew
    /[\u0900-\u097F]/.test(text)                            // Devanagari
}

const ADULT_DOMAIN_PATTERNS = [
  /(?:^|[.\-/])xxx\d*\./i, /\badult\./i, /\bporn\./i, /\bsex\./i,
  /\bonlyfans\./i,
]

function extractDomain(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname + (u.port ? `:${u.port}` : '')
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0]
  }
}

function fingerprint(streams: Stream[]): Set<string> {
  return new Set(streams.slice(0, 25).map(s => s.title.toLowerCase().trim()))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0
  for (const item of a) { if (b.has(item)) intersection++ }
  const union = new Set([...a, ...b])
  return union.size === 0 ? 0 : intersection / union.size
}

const DUPLICATE_SIMILARITY = 0.7

async function fetchPortalCategories(p: Portal): Promise<{ id: string; name: string }[]> {
  try {
    const url = `${p.url}/player_api.php?username=${encodeURIComponent(p.username)}&password=${encodeURIComponent(p.password)}&action=get_live_categories`
    const res = await axios.get(url, {
      timeout: VERIFY_TIMEOUT,
      headers: { 'User-Agent': 'VLC/3.0.20', Accept: 'application/json,*/*' },
    })
    const data = res.data
    if (!Array.isArray(data)) return []
    return data.map((c: any) => ({
      id: (c.category_id || '').toString(),
      name: (c.category_name || c.name || '').toString(),
    }))
  } catch {
    return []
  }
}

async function fetchContent(url: string, timeoutMs = 15000): Promise<string | null> {
  const makeRequest = async (targetUrl: string): Promise<string | null> => {
    try {
      const res = await axios.get(targetUrl, {
        timeout: timeoutMs,
        headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
        validateStatus: () => true,
      })
      if (res.status >= 200 && res.status < 300) return res.data
    } catch {}
    return null
  }

  let result = await makeRequest(url)
  if (result) return result

  for (const build of CORS_PROXIES) {
    result = await makeRequest(build(url))
    if (result && !result.startsWith('<!doctype') && !result.includes('<title>Blocked</title>')) return result
  }

  return null
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

async function fetchGitHubRepoPortals(cfg: typeof GITHUB_PORTAL_REPOS[0], logger: Logger): Promise<Portal[]> {
  let files: { url: string; name: string }[] = []

  try {
    const apiUrl = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.path}?ref=${cfg.ref}`
    const res = await axios.get(apiUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      timeout: 15000,
    })
    const entries: any[] = res.data
    files = entries
      .filter((e: any) => e.type === 'file' && /\.txt$/i.test(e.name) && e.download_url)
      .sort((a: any, b: any) => (a.size || 0) - (b.size || 0))
      .map((e: any) => ({ url: e.download_url, name: e.name }))
    logger.info(`  listed ${files.length} files from ${cfg.owner}/${cfg.repo}`)
  } catch (err: any) {
    if (cfg.fallbackFiles) {
      logger.warn(`  GitHub API failed for ${cfg.owner}/${cfg.repo}: ${err.message?.substring(0, 60) || err}, using fallback`)
      const base = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.ref}/${cfg.path}/`
      files = cfg.fallbackFiles.map(n => ({ url: base + n, name: n }))
    } else {
      logger.warn(`  GitHub API failed for ${cfg.owner}/${cfg.repo}: ${err.message?.substring(0, 60) || err}, skipping`)
      return []
    }
  }

  const portals: Portal[] = []
  const seen = new Set<string>()

  for (const file of files) {
    try {
      const res = await axios.get(file.url, { timeout: 15000, headers: { 'User-Agent': UA } })
      const found = extractPortals(res.data, `github/${cfg.repo}:${file.name}`)
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

async function fetchGitHubPortals(logger: Logger): Promise<Portal[]> {
  const allPortals: Portal[] = []
  const seen = new Set<string>()

  for (const cfg of GITHUB_PORTAL_REPOS) {
    const found = await fetchGitHubRepoPortals(cfg, logger)
    for (const p of found) {
      const key = `${p.url}|${p.username}|${p.password}`
      if (seen.has(key)) continue
      seen.add(key)
      allPortals.push(p)
    }
  }

  return allPortals
}

async function fetchRedditPortals(logger: Logger): Promise<Portal[]> {
  const portals: Portal[] = []
  const seenPastes = new Set<string>()

  try {
    const text = await fetchContent('https://www.reddit.com/r/IPTV_ZONENEW/new/.json?limit=100&sort=new', 20000)
    if (!text) {
      logger.warn('  Reddit r/IPTV_ZONENEW returned no data')
      return portals
    }

    let root: any
    try { root = JSON.parse(text) } catch {
      logger.warn('  Reddit r/IPTV_ZONENEW returned non-JSON (likely blocked)')
      return portals
    }

    const posts: any[] = root?.data?.children || []
    logger.info(`  fetched ${posts.length} posts from r/IPTV_ZONENEW`)

    for (const post of posts) {
      const pdata = post?.data
      if (!pdata) continue
      const title = pdata.title?.toString() || ''
      const body = `${title} ${pdata.selftext?.toString() || ''}`.trim()
      portals.push(...extractPortals(body, `reddit:IPTV_ZONENEW`))

      const deepLinks = new Set<string>()
      for (const bm of body.match(B64) || []) {
        try {
          const decoded = Buffer.from(bm, 'base64').toString('utf-8')
          if (decoded.startsWith('http') && PASTE_DOMAINS.some(d => decoded.includes(d))) {
            deepLinks.add(decoded)
          } else if (!decoded.startsWith('http') && decoded.includes(':')) {
            portals.push(...extractPortals(decoded, `reddit/b64:IPTV_ZONENEW`))
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
        const pasteText = await fetchPasteContent(dl)
        if (pasteText) portals.push(...extractPortals(pasteText, `reddit/deep:IPTV_ZONENEW`))
      }
    }
  } catch (err: any) {
    logger.warn(`  Reddit r/IPTV_ZONENEW failed: ${err.message?.substring(0, 60) || err}`)
  }

  return portals
}

async function verifyPortal(p: Portal, logger: Logger): Promise<VerifiedPortal | null> {
  const encUser = encodeURIComponent(p.username)
  const encPass = encodeURIComponent(p.password)

  // Check for adult keywords in domain name
  if (ADULT_DOMAIN_PATTERNS.some(re => re.test(p.url))) {
    return null
  }

  // Try player_api.php first (full Xtream API)
  try {
    const url = `${p.url}/player_api.php?username=${encUser}&password=${encPass}`
    const res = await axios.get(url, {
      timeout: VERIFY_TIMEOUT,
      headers: { 'User-Agent': 'VLC/3.0.20', Accept: 'application/json,*/*' },
      validateStatus: () => true,
    })
    const data = res.data
    if (res.status >= 200 && res.status < 300 && data && typeof data === 'object') {
      const info = data.user_info || data
      const auth = String(info.auth || '')
      const status = (info.status || '').toString().toLowerCase()
      if (auth === '1' || status === 'active' || data.user_info) {
        const name = (info.username || p.username).toString()
        const categories = await fetchPortalCategories(p)
        if (categories.length > 0) {
          const adultCount = categories.filter(c => isAdultCategory(c.name)).length
          if (adultCount / categories.length >= ADULT_PENALTY_THRESHOLD) {
            logger.info(`  Skipped (adult content): ${name} — ${adultCount}/${categories.length} categories adult`)
            return null
          }
        }
        return { portal: p, name, domain: extractDomain(p.url) }
      }
    }
  } catch {}

  // Fallback: try get.php (returns raw M3U playlist)
  try {
    const url = `${p.url}/get.php?username=${encUser}&password=${encPass}&type=m3u_plus`
    const res = await axios.get(url, {
      timeout: VERIFY_TIMEOUT,
      headers: { 'User-Agent': 'VLC/3.0.20' },
      validateStatus: () => true,
    })
    if (res.status >= 200 && res.status < 300 && typeof res.data === 'string' && /#EXTM3U/i.test(res.data)) {
      if (/<html|<head|<body|XUI\.one|Debug\s*Mode/i.test(res.data)) return null
      const lines = res.data.split('\n')
      let extinfCount = 0
      let urlCount = 0
      let afterExtinf = false
      for (const line of lines) {
        if (line.startsWith('#EXTINF')) {
          extinfCount++
          afterExtinf = true
        } else if (afterExtinf && line.startsWith('http')) {
          urlCount++
          afterExtinf = false
        } else if (!line.startsWith('#')) {
          afterExtinf = false
        }
      }
      if (urlCount < 5) return null

      const name = p.username
      const sample = res.data.split('\n').slice(0, 30).join('\n')
      let adultHits = 0
      let nonEnglishHits = 0
      let totalLines = 0
      for (const line of sample.split('\n')) {
        if (line.startsWith('#EXTINF')) {
          totalLines++
          if (isAdultStreamName(line)) adultHits++
          if (hasNonLatinScript(line)) nonEnglishHits++
        }
      }
      if (totalLines > 0 && (adultHits / totalLines >= ADULT_PENALTY_THRESHOLD || nonEnglishHits / totalLines >= ADULT_PENALTY_THRESHOLD)) {
        logger.info(`  Skipped: ${name} — ${adultHits}/${totalLines} adult, ${nonEnglishHits}/${totalLines} non-English`)
        return null
      }
      return { portal: p, name, domain: extractDomain(p.url) }
    }
  } catch {}

  return null
}

async function fetchPortalStreamsM3u(p: VerifiedPortal, logger: Logger): Promise<Stream[]> {
  try {
    const url = `${p.portal.url}/get.php?username=${encodeURIComponent(p.portal.username)}&password=${encodeURIComponent(p.portal.password)}&type=m3u_plus`
    const res = await axios.get(url, {
      timeout: FETCH_TIMEOUT,
      headers: { 'User-Agent': 'VLC/3.0.20' },
    })
    const text: string = res.data
    if (!text || typeof text !== 'string') return []

    const groupTitle = `! Portals - ${p.name}`
    const out: Stream[] = []
    const titleCount = new Map<string, number>()
    let count = 0
    let currentExtinf = ''

    for (const line of text.split('\n')) {
      if (count >= MAX_STREAMS_PER_PORTAL) break

      if (line.startsWith('#EXTINF')) {
        currentExtinf = line
        continue
      }

      if (!currentExtinf || line.startsWith('#') || !line.trim()) continue

      const url = line.trim()
      if (!url.startsWith('http')) continue

      const nameMatch = currentExtinf.match(/,([^,]*)$/)
      const rawName = nameMatch ? nameMatch[1].trim() : 'Unknown'
      const tvgIdMatch = currentExtinf.match(/tvg-id="([^"]*)"/)
      const tvgId = tvgIdMatch ? tvgIdMatch[1] : `${p.name}:${count + 1}`
      const tvgLogoMatch = currentExtinf.match(/tvg-logo="([^"]*)"/)
      const tvgLogo = tvgLogoMatch ? tvgLogoMatch[1] : ''

      if (isAdultStreamName(rawName) || hasNonLatinScript(rawName)) {
        currentExtinf = ''
        continue
      }

      const name = (() => {
        const idx = (titleCount.get(rawName) ?? 0) + 1
        titleCount.set(rawName, idx)
        return idx === 1 ? rawName : `str ${idx} - ${rawName}`
      })()

      const stream = new Stream({
        channel: tvgId,
        title: name,
        url,
        quality: null,
        referrer: null,
        user_agent: null,
        label: null,
        feed: null,
      })
      stream.tvgId = tvgId
      stream.tvgLogo = tvgLogo
      stream.groupTitle = groupTitle
      out.push(stream)
      count++
      currentExtinf = ''
    }

    return out
  } catch {
    return []
  }
}

async function fetchPortalStreams(p: VerifiedPortal, logger: Logger): Promise<Stream[]> {
  // Try Xtream API first
  try {
    const url = `${p.portal.url}/player_api.php?username=${encodeURIComponent(p.portal.username)}&password=${encodeURIComponent(p.portal.password)}&action=get_live_streams`
    const res = await axios.get(url, {
      timeout: FETCH_TIMEOUT,
      headers: { 'User-Agent': 'VLC/3.0.20', Accept: 'application/json,*/*' },
    })
    const streams: any[] = res.data
    if (Array.isArray(streams) && streams.length > 0) {
      const groupTitle = `! Portals - ${p.name}`
      const user = encodeURIComponent(p.portal.username)
      const pass = encodeURIComponent(p.portal.password)
      const base = p.portal.url.replace(/\/+$/, '')
      const out: Stream[] = []
      const titleCount = new Map<string, number>()
      let count = 0

      for (const s of streams) {
        if (count >= MAX_STREAMS_PER_PORTAL) break
        const streamId = s.stream_id?.toString() || s.id?.toString() || ''
        const rawName = s.name?.toString() || s.title?.toString() || ''
        if (!streamId || !rawName) continue

        const categoryName = (s.category_name || '').toString()
        if (isAdultCategory(categoryName) || isAdultStreamName(rawName) || hasNonLatinScript(rawName)) continue

        const name = (() => {
          const idx = (titleCount.get(rawName) ?? 0) + 1
          titleCount.set(rawName, idx)
          return idx === 1 ? rawName : `str ${idx} - ${rawName}`
        })()

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
    }
  } catch {}

  // Fallback: parse M3U from get.php
  return fetchPortalStreamsM3u(p, logger)
}

export async function scrapePortals(logger: Logger): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []

  logger.info('=== Portal Scraper ===')

  logger.info('Fetching portal credentials from GitHub...')
  const gitPortals = await fetchGitHubPortals(logger)
  logger.info(`Found ${gitPortals.length} raw portals from GitHub`)

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
    const vp = await verifyPortal(portal, logger)
    if (vp) {
      verified.push(vp)
      logger.info(`  Verified: ${vp.name} @ ${portal.url.substring(0, 50)}...`)
    }
  })

  logger.info(`Verified ${verified.length} portals`)

  if (verified.length === 0) return result

  logger.info(`Fetching live streams from ${verified.length} verified portals...`)

  // Fetch all portal streams first
  const portalStreams: { vp: VerifiedPortal; streams: Stream[] }[] = []
  await eachLimit(verified, 3, async (vp) => {
    const streams = await fetchPortalStreams(vp, logger)
    portalStreams.push({ vp, streams })
    logger.info(`  ${vp.name} @ ${vp.domain}: ${streams.length} live streams`)
  })

  // Group by domain
  const domainMap = new Map<string, { vp: VerifiedPortal; streams: Stream[]; fprint: Set<string> }[]>()
  for (const ps of portalStreams) {
    if (ps.streams.length === 0) continue
    const list = domainMap.get(ps.vp.domain) || []
    list.push({ ...ps, fprint: fingerprint(ps.streams) })
    domainMap.set(ps.vp.domain, list)
  }

  // For each domain: dedup, merge, deduplicate by URL
  for (const [domain, entries] of domainMap) {
    // Sort by stream count descending
    entries.sort((a, b) => b.streams.length - a.streams.length)

    // Pick non-duplicate entries
    const accepted: typeof entries = []
    for (const entry of entries) {
      let isDuplicate = false
      for (const acc of accepted) {
        if (jaccard(entry.fprint, acc.fprint) > DUPLICATE_SIMILARITY) {
          isDuplicate = true
          break
        }
      }
      if (!isDuplicate) accepted.push(entry)
    }

    // Merge streams from accepted entries, dedup by URL
    const groupTitle = `! Portals - ${domain}`
    const seenUrls = new Set<string>()
    const merged: Stream[] = []
    for (const entry of accepted) {
      for (const s of entry.streams) {
        if (seenUrls.has(s.url)) continue
        seenUrls.add(s.url)
        s.groupTitle = groupTitle
        merged.push(s)
      }
    }

    if (accepted.length < entries.length) {
      logger.info(`  Merged ${entries.length} portals for ${domain} -> ${accepted.length} unique groups (${merged.length} unique streams)`)
    }

    result.push({ groupTitle, streams: merged })
  }

  return result
}
