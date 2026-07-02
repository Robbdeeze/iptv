import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import axios from 'axios'
import { eachLimit } from 'async'
import crypto from 'crypto'

const VERIFY_TIMEOUT = parseInt(process.env.VERIFY_TIMEOUT || '') || 8000
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '') || 15000
const MAX_VERIFIED = parseInt(process.env.MAX_VERIFIED_PORTALS || '') || 30
const MAX_STREAMS_PER_PORTAL = parseInt(process.env.MAX_STREAMS_PER_PORTAL || '') || 500

// Permanent portal domains - never removed, always included when available
const KEEP_PORTAL_DOMAINS = ['jackofclubs.vip', 'vividmedia.xyz', 'cord-cutter.net']

const UA = 'Mozilla/5.0 (Linux; Android 11; PlayTorrio) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

const CORS_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u: string) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}`,
  (u: string) => `https://api.cors.lol/?url=${encodeURIComponent(u)}`,
  (u: string) => `https://proxy.corsfix.com/?${encodeURIComponent(u)}`,
]

const TELEGRAM_CHANNELS = ['xtreamcodes']

const SHORTENER_DOMAINS = ['oxy.st', 'oxy.name', 'try2link.com', 'linkvertise.com', 'exe.io', 'sh.st']

// Circuit breaker state per proxy
const PROXY_FAIL_THRESHOLD = 2
const PROXY_COOLDOWN_MS = 45000
const PROXY_RATE_COOLDOWN_MS = 90000
const proxyState = new Map<string, { fails: number; cooldownUntil: number }>()
function isProxyHealthy(build: (u: string) => string): boolean {
  const state = proxyState.get(build.name)
  if (!state) return true
  if (state.cooldownUntil > Date.now()) return false
  state.fails = 0
  state.cooldownUntil = 0
  return true
}
function markProxyFailure(build: (u: string) => string, status?: number) {
  let state = proxyState.get(build.name)
  if (!state) {
    state = { fails: 0, cooldownUntil: 0 }
    proxyState.set(build.name, state)
  }
  state.fails++
  const cd = status === 429 ? PROXY_RATE_COOLDOWN_MS : PROXY_COOLDOWN_MS
  state.cooldownUntil = Date.now() + cd
}
function markProxySuccess(build: (u: string) => string) {
  const state = proxyState.get(build.name)
  if (state) { state.fails = 0; state.cooldownUntil = 0 }
}

async function followShortener(url: string, depth = 5): Promise<string | null> {
  if (depth === 0 || !url.startsWith('http')) return url || null
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': UA }, maxRedirects: 5 })
    const html: string = typeof res.data === 'string' ? res.data : ''
    const meta = html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']\d*;?\s*url=([^"']+)["']/i)
    if (meta && meta[1]) return followShortener(new URL(meta[1], url).toString(), depth - 1)
    const loc = html.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/)
    if (loc && loc[1]) return followShortener(new URL(loc[1], url).toString(), depth - 1)
    return res.request?.res?.responseUrl || url
  } catch { return null }
}

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
  const makeRequest = async (targetUrl: string): Promise<{ data: string | null; status?: number }> => {
    try {
      const res = await axios.get(targetUrl, {
        timeout: timeoutMs,
        headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*' },
        validateStatus: () => true,
      })
      if (res.status >= 200 && res.status < 300) return { data: res.data }
      return { data: null, status: res.status }
    } catch {
      return { data: null }
    }
  }

  // Try direct first
  const direct = await makeRequest(url)
  if (direct.data) return direct.data

  // Try proxies with circuit breaker (race-based, fire healthy ones)
  const healthy = CORS_PROXIES.filter(isProxyHealthy)
  if (healthy.length === 0) return null

  for (const build of healthy) {
    const result = await makeRequest(build(url))
    if (result.data && !result.data.startsWith('<!doctype') && !result.data.includes('<title>Blocked</title>')) {
      markProxySuccess(build)
      return result.data
    }
    if (result.status && result.status >= 400) {
      markProxyFailure(build, result.status)
    } else {
      markProxyFailure(build)
    }
  }

  return null
}

async function decryptPasteSh(raw: string, clientKey: string, id: string): Promise<string | null> {
  // First line is serverkey (blank if none), rest is base64 content
  const rawLines = raw.split('\n')
  const serverkey = rawLines[0]?.trim() || ''
  const b64 = rawLines.slice(1).join('')
  const buf = Buffer.from(b64, 'base64')
  if (buf.length < 16 || buf.toString('utf-8', 0, 8) !== 'Salted__') return null

  const salt = buf.subarray(8, 16)
  const ct = buf.subarray(16)
  // password = id + serverkey + clientKey + 'https://paste.sh'
  const password = `${id}${serverkey}${clientKey}https://paste.sh`

  // Try v2: PBKDF2-HMAC-SHA512 (ptype v2/v3, uses OpenSSLPbkdf2)
  // DK = HMAC-SHA512(password, salt || 0x00000001)
  try {
    const blockIndex = Buffer.alloc(4)
    blockIndex.writeUInt32BE(1, 0)
    const hmac = crypto.createHmac('sha512', Buffer.from(password))
    const dk = hmac.update(Buffer.concat([salt, blockIndex])).digest()
    const key = dk.subarray(0, 32)
    const iv = dk.subarray(32, 48)
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
  } catch {}

  // Try v1: EVP_BytesToKey with SHA-512 (legacy ptype v1, openssl enc -iter 1)
  try {
    const d0 = crypto.createHash('sha512').update(Buffer.from(password)).update(salt).digest()
    const key = d0.subarray(0, 32)
    const iv = d0.subarray(32, 48)
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
  } catch {}

  // Fallback: hex-based format with PBKDF2-SHA512 (original assumption)
  try {
    const hexBuf = Buffer.from(raw.replace(/^.*\n/, ''), 'hex')
    if (hexBuf.length < 48) return null
    const hexSalt = hexBuf.subarray(0, 32)
    const hexIv = hexBuf.subarray(32, 48)
    const hexCt = hexBuf.subarray(48)
    const key = await new Promise<Buffer>((resolve, reject) => {
      crypto.pbkdf2(clientKey, hexSalt, 100000, 32, 'sha512', (err, k) => {
        if (err) reject(err); else resolve(k)
      })
    })
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, hexIv)
    decipher.setAutoPadding(true)
    return Buffer.concat([decipher.update(hexCt), decipher.final()]).toString('utf-8')
  } catch {}

  return null
}

async function fetchPasteContent(url: string): Promise<string | null> {
  try {
    if (url.includes('paste.sh')) {
      const fragmentIdx = url.indexOf('#')
      const clientKey = fragmentIdx >= 0 ? url.substring(fragmentIdx + 1) : ''
      if (!clientKey) return null
      const baseUrl = fragmentIdx >= 0 ? url.substring(0, fragmentIdx) : url
      const id = baseUrl.replace(/\/+$/, '').split('/').pop() || ''
      const txtUrl = baseUrl.replace(/\/+$/, '') + '.txt'
      const res = await axios.get(txtUrl, { timeout: 10000, headers: { 'User-Agent': UA } })
      const raw = (res.data || '').toString()
      if (!raw) return null
      return await decryptPasteSh(raw, clientKey, id)
    }
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

  // Use Reddit RSS feed — not blocked by Reddit's anti-bot (unlike JSON API)
  try {
    const url = 'https://www.reddit.com/r/IPTV_ZONENEW/new/.rss?limit=100'
    const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': UA } })
    const xml: string = typeof res.data === 'string' ? res.data : ''
    if (!xml) { logger.warn('  Reddit RSS returned empty response'); return portals }

    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g
    const entries: string[] = []
    let m: RegExpExecArray | null
    while ((m = entryRegex.exec(xml)) !== null) entries.push(m[1])

    logger.info(`  RSS: ${entries.length} r/IPTV_ZONENEW posts`)

    for (const entry of entries) {
      const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)
      const contentMatch = entry.match(/<content type="html">([\s\S]*?)<\/content>/)
      const title = titleMatch ? titleMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : ''
      const content = contentMatch ? contentMatch[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/<[^>]+>/g, ' ').trim() : ''
      const body = `${title} ${content}`.trim()
      if (!body) continue

      portals.push(...extractPortals(body, 'reddit:IPTV_ZONENEW'))

      const deepLinks = new Set<string>()
      for (const bm of body.match(B64) || []) {
        try {
          const decoded = Buffer.from(bm, 'base64').toString('utf-8')
          if (decoded.startsWith('http') && PASTE_DOMAINS.some(d => decoded.includes(d))) deepLinks.add(decoded)
          else if (!decoded.startsWith('http') && decoded.includes(':')) portals.push(...extractPortals(decoded, 'reddit/b64:IPTV_ZONENEW'))
        } catch { }
      }
      for (const pm of body.match(RAW_PASTE) || []) deepLinks.add(pm)

      let dlCount = 0
      for (const dl of deepLinks) {
        if (dlCount >= 4) break
        const pk = dl.replace(/\/+$/, '').toLowerCase()
        if (seenPastes.has(pk)) continue
        seenPastes.add(pk)
        dlCount++
        const pasteText = await fetchPasteContent(dl)
        if (pasteText) portals.push(...extractPortals(pasteText, 'reddit/deep:IPTV_ZONENEW'))
      }
    }
  } catch (err: any) {
    logger.warn(`  Reddit RSS failed: ${err.message?.substring(0, 60) || err}`)
  }

  if (portals.length > 0) return portals

  // Last resort: reddit.com via CORS proxies
  logger.info('  RSS returned 0 portals, trying Reddit.com via CORS proxies...')
  {
    let after: string | null = null
    for (let page = 0; page < 3; page++) {
      let url = 'https://www.reddit.com/r/IPTV_ZONENEW/new/.json?limit=100&sort=new'
      if (after) url += `&after=${encodeURIComponent(after)}`
      try {
        const text = await fetchContent(url, 20000)
        if (!text) { logger.warn('  Reddit via proxy returned no data'); break }
        let root: any
        try { root = JSON.parse(text) } catch { logger.warn(`  Reddit via proxy returned non-JSON (page ${page + 1})`); break }
        const posts: any[] = root?.data?.children || []
        if (posts.length === 0) break
        after = root?.data?.after || null
        logger.info(`  Proxy: ${posts.length} r/IPTV_ZONENEW posts (page ${page + 1})`)
        for (const post of posts) {
          const pdata = post?.data
          if (!pdata) continue
          const body = `${pdata.title?.toString() || ''} ${pdata.selftext?.toString() || ''}`.trim()
          portals.push(...extractPortals(body, 'reddit:IPTV_ZONENEW'))
          const deepLinks = new Set<string>()
          for (const bm of body.match(B64) || []) {
            try {
              const decoded = Buffer.from(bm, 'base64').toString('utf-8')
              if (decoded.startsWith('http') && PASTE_DOMAINS.some(d => decoded.includes(d))) deepLinks.add(decoded)
              else if (!decoded.startsWith('http') && decoded.includes(':')) portals.push(...extractPortals(decoded, 'reddit/b64:IPTV_ZONENEW'))
            } catch { }
          }
          for (const pm of body.match(RAW_PASTE) || []) deepLinks.add(pm)
          let dlCount = 0
          for (const dl of deepLinks) {
            if (dlCount >= 4) break
            const pk = dl.replace(/\/+$/, '').toLowerCase()
            if (seenPastes.has(pk)) continue
            seenPastes.add(pk)
            dlCount++
            const pasteText = await fetchPasteContent(dl)
            if (pasteText) portals.push(...extractPortals(pasteText, 'reddit/deep:IPTV_ZONENEW'))
          }
        }
        if (!after) break
      } catch (err: any) { logger.warn(`  Reddit via proxy page ${page + 1} failed: ${err.message?.substring(0, 60) || err}`); break }
    }
  }

  return portals
}

async function fetchTelegramPortals(logger: Logger): Promise<Portal[]> {
  const portals: Portal[] = []
  const seenPastes = new Set<string>()
  const seen = new Set<string>()
  const MAX_TELEGRAM_PAGES = 3

  for (const channel of TELEGRAM_CHANNELS) {
    let before: string | null = null
    const beforeCount = portals.length

    for (let page = 0; page < MAX_TELEGRAM_PAGES; page++) {
      let url = `https://t.me/s/${channel}`
      if (before) url += `?before=${before}`

      try {
        const res = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': UA }, validateStatus: (s) => s >= 200 && s < 400 })
        const html: string = typeof res.data === 'string' ? res.data : ''
        if (!html) break

        const msgRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g
        const messages: string[] = []
        let m: RegExpExecArray | null
        while ((m = msgRegex.exec(html)) !== null) {
          const text = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()
          if (text) messages.push(text)
        }

        for (const msg of messages) {
          for (const p of extractPortals(msg, `telegram:${channel}`)) {
            const key = `${p.url}|${p.username}|${p.password}`
            if (!seen.has(key)) { seen.add(key); portals.push(p) }
          }

          for (const pm of msg.match(RAW_PASTE) || []) {
            const pk = pm.replace(/\/+$/, '').toLowerCase()
            if (seenPastes.has(pk)) continue
            seenPastes.add(pk)
            const pasteText = await fetchPasteContent(pm)
            if (pasteText) {
              for (const p of extractPortals(pasteText, `telegram/deep:${channel}`)) {
                const key = `${p.url}|${p.username}|${p.password}`
                if (!seen.has(key)) { seen.add(key); portals.push(p) }
              }
            }
          }

          const shortRx = new RegExp(`https?://(?:${SHORTENER_DOMAINS.join('|')})/[a-zA-Z0-9_=-]+`, 'gi')
          for (const sm of msg.match(shortRx) || []) {
            const resolvedUrl = await followShortener(sm)
            if (resolvedUrl && PASTE_DOMAINS.some(d => resolvedUrl.includes(d))) {
              const pk = resolvedUrl.replace(/\/+$/, '').toLowerCase()
              if (seenPastes.has(pk)) continue
              seenPastes.add(pk)
              const pasteText = await fetchPasteContent(resolvedUrl)
              if (pasteText) {
                for (const p of extractPortals(pasteText, `telegram/short:${channel}`)) {
                  const key = `${p.url}|${p.username}|${p.password}`
                  if (!seen.has(key)) { seen.add(key); portals.push(p) }
                }
              }
            }
          }
        }

        const beforeMatch = html.match(/\?before=(\d+)/)
        if (beforeMatch && beforeMatch[1] !== before) before = beforeMatch[1]
        else break
      } catch (err: any) {
        logger.warn(`  Telegram @${channel} page ${page + 1} failed: ${err.message?.substring(0, 60) || err}`)
        break
      }
    }

    const channelCount = portals.length - beforeCount
    if (channelCount > 0) logger.info(`  Telegram @${channel}: ${channelCount} portals`)
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

  logger.info('Fetching portal credentials from Telegram...')
  const telegramPortals = await fetchTelegramPortals(logger)
  logger.info(`Found ${telegramPortals.length} raw portals from Telegram`)

  const deduped = new Map<string, Portal>()
  for (const p of [...gitPortals, ...redditPortals, ...telegramPortals]) {
    const key = `${p.url}|${p.username}|${p.password}`.toLowerCase()
    if (!deduped.has(key)) deduped.set(key, p)
  }

  const allPortals = [...deduped.values()]
  logger.info(`Total unique raw portals: ${allPortals.length}`)

  if (allPortals.length === 0) return result

  logger.info(`Verifying up to ${Math.min(allPortals.length, MAX_VERIFIED * 3)} portals (will keep ${MAX_VERIFIED} verified)...`)
  const verified: VerifiedPortal[] = []

  // Verify up to 3 entries per whitelisted domain first, then fill rest
  const whitelisted = allPortals.filter(p => KEEP_PORTAL_DOMAINS.some(d => p.url.includes(d)))
  const rest = allPortals.filter(p => !KEEP_PORTAL_DOMAINS.some(d => p.url.includes(d)))

  // Limit whitelisted verification: ensure at least 1 per domain, at most 5
  const whitelistByDomain = new Map<string, typeof allPortals>()
  for (const p of whitelisted) {
    const domain = KEEP_PORTAL_DOMAINS.find(d => p.url.includes(d)) || 'other'
    const list = whitelistByDomain.get(domain) || []
    if (list.length < 5) list.push(p)
    whitelistByDomain.set(domain, list)
  }
  const cappedWhitelisted = [...whitelistByDomain.values()].flat()
  const ordered = [...cappedWhitelisted, ...rest]

  await eachLimit(ordered, 10, async (portal) => {
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
    const isKept = KEEP_PORTAL_DOMAINS.some(d => domain.includes(d))

    if (isKept) {
      // Keep all entries for whitelisted domains (no dedup)
      const groupTitle = `! Portals - ${domain}`
      const seenUrls = new Set<string>()
      const merged: Stream[] = []
      for (const entry of entries) {
        for (const s of entry.streams) {
          if (seenUrls.has(s.url)) continue
          seenUrls.add(s.url)
          s.groupTitle = groupTitle
          merged.push(s)
        }
      }
      logger.info(`  Keeping ${merged.length} streams for whitelisted domain ${domain}`)
      result.push({ groupTitle, streams: merged })
      continue
    }

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
