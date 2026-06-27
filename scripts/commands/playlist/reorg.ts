import fs from 'node:fs'
import path from 'node:path'

const INPUT = path.resolve(process.cwd(), 'Robbdeeze_UltimateTV.m3u')
const OUTPUT = path.resolve(process.cwd(), 'Robbdeeze_UltimateTV_Clean.m3u')

interface Entry {
  extinf: string
  url: string
  groupTitle: string
  title: string
  tvgId: string
  tvgLogo: string
  raw: string
}

function parseEntries(content: string): Entry[] {
  const lines = content.split('\n')
  const entries: Entry[] = []

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trimEnd()
    if (!line) continue

    if (line.startsWith('#EXTINF:')) {
      let extinf = line
      let urlLine = ''
      i++
      while (i < lines.length) {
        const next = lines[i].trimEnd()
        if (!next) { i++; continue }
        if (next.startsWith('#EXTINF:')) { i--; break }
        if (next.startsWith('#EXTVLCOPT:') || next.startsWith('#KODIPROP:')) {
          extinf += '\n' + next
          i++
          continue
        }
        urlLine = next
        if (urlLine.startsWith('http')) break
        i++
      }

      const gtMatch = extinf.match(/group-title="([^"]*)"/)
      const groupTitle = gtMatch ? gtMatch[1] : 'Undefined'

      const titleMatch = extinf.match(/,\s*(.+)$/)
      const title = titleMatch ? titleMatch[1].trim() : ''

      const tvgIdMatch = extinf.match(/tvg-id="([^"]*)"/)
      const tvgId = tvgIdMatch ? tvgIdMatch[1] : ''

      const tvgLogoMatch = extinf.match(/tvg-logo="([^"]*)"/)
      const tvgLogo = tvgLogoMatch ? tvgLogoMatch[1] : ''

      entries.push({ extinf, url: urlLine, groupTitle, title, tvgId, tvgLogo, raw: extinf + '\n' + urlLine })
    }
  }

  return entries
}

function extractShowName(raw: string): string | null {
  let t = raw.trim()

  // Strip source prefixes like [HR], [Telegram - ...], [TorrentCouch.com]., etc.
  t = t.replace(/^\[[^\]]*\]\s*/, '')
  t = t.replace(/^\[[^\]]*\]\./, '')

  // Remove trailing file metadata like [hash].mkv, .720p.BRRip.x264.mp4, etc.
  t = t.replace(/\s*\[[A-F0-9]{8}\]\.\w{3,4}$/, '')
  t = t.replace(/\.\d{3,4}p\..*$/, '')

  // Extract show name before S\d+E\d+
  const m = t.match(/^(.+?)\s+S\d+E\d+/)
  if (m) {
    let name = m[1].trim()
    // Clean dots from TorrentCouch-style names (e.g., "Black.Lightning" -> "Black Lightning")
    name = name.replace(/\./g, ' ')
    name = name.replace(/\s+/g, ' ')
    return name
  }

  // Sometimes just S\d+ without episode
  const m2 = t.match(/^(.+?)\s+S\d+/)
  if (m2) {
    let name = m2[1].trim()
    name = name.replace(/\./g, ' ')
    name = name.replace(/\s+/g, ' ')
    return name
  }

  return null
}

function classify(gt: string, title: string): { section: string; subGroup: string } {
  const g = gt.toLowerCase().trim()

  // VOD detection
  if (g.startsWith('vod -')) {
    if (g.includes('tv shows') || g.includes('tv_shows')) {
      const showName = extractShowName(title)
      if (showName) {
        return { section: 'vod-tv', subGroup: `VOD - TV Shows - ${showName}` }
      }
      return { section: 'vod-tv', subGroup: 'VOD - TV Shows - Other' }
    }
    if (g.includes('movies') || g.includes('movie')) return { section: 'vod-movies', subGroup: 'VOD - Movies' }
    return { section: 'vod-other', subGroup: gt }
  }

  // Sports scraper channels (live sports channels)
  if (g.includes('! sports -') || g === '! sports - daddylive' || g === '! sports - streamed' || g === '! sports - roxie') {
    return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
  }

  // Sports event/league groups
  if (g.includes('powersports') || g.includes('streambtw') || g.includes('streameast') || g.includes('roxies') || g.includes('roxiestream')) {
    if (g.includes('ufc') || g.includes('mma') || g.includes('boxing') || g.includes('fighting')) {
      return { section: 'sports-combat', subGroup: 'Sports - Combat / Fighting' }
    }
    if (g.includes('formula') || g.includes('f1') || g.includes('motorsports') || g.includes('racing') || g.includes('nascar')) {
      return { section: 'sports-motorsports', subGroup: 'Sports - Motorsports / Racing' }
    }
    if (g.includes('epl') || g.includes('premier league') || g.includes('soccer')) {
      return { section: 'sports-football', subGroup: 'Sports - Football' }
    }
    if (g.includes('live event') || g.includes('ppv') || g.includes('live games') || g.includes('live sports')) {
      return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
    }
    return { section: 'sports-other', subGroup: 'Sports - Other' }
  }

  // MLB/NHL/OnHockey webcast
  if (g.includes('mlbwebcast') || g.includes('nhlwebcast') || g.includes('onhockey')) {
    return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
  }

  // A1xmedia
  if (g.startsWith('a1xmedia')) {
    if (g.includes('epl')) return { section: 'sports-football', subGroup: 'Sports - Football' }
    if (g.includes('live event') || g.includes('ppv')) return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
    if (g.includes('uhd') || g.includes('4k')) return { section: 'sports-other', subGroup: 'Sports - Other (UHD/4K)' }
    if (g.includes('sports')) return { section: 'sports-other', subGroup: 'Sports - Other' }
    if (g.includes('channel')) return { section: 'other', subGroup: gt }
    return { section: 'other', subGroup: gt }
  }

  // TimStreams
  if (g.startsWith('timstreams')) {
    if (g.includes('event')) return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
    return { section: 'other', subGroup: gt }
  }

  // News groups
  if (g === 'news' || g.includes('cbsn') || g.includes('abcnews') || g.includes('bbc news') || g.includes('cnn') || g.includes('fox news')) {
    return { section: 'news', subGroup: 'News' }
  }

  // US groups
  if (g === 'united states' || g.startsWith('us -') || g.startsWith('us_')) {
    return { section: 'us', subGroup: gt }
  }

  // Canada
  if (g === 'canada' || g.startsWith('ca -') || g.startsWith('ca_')) {
    return { section: 'canada', subGroup: gt }
  }

  // UK groups
  if (g === 'united kingdom' || g.startsWith('uk -') || g.startsWith('uk_')) {
    return { section: 'uk', subGroup: gt }
  }

  // LocalNow
  if (g === 'localnow') {
    return { section: 'localnow', subGroup: 'LocalNow' }
  }

  // Drew groups
  if (g.startsWith('drewlive') || g.startsWith('drewfx')) {
    return { section: 'drew', subGroup: gt }
  }

  // YueChan
  if (g.includes('yuechan')) return { section: 'international', subGroup: gt }

  // IPTVjs 
  if (g.includes('iptvjs')) return { section: 'adult', subGroup: gt }

  // Famelack
  if (g.includes('famelack')) return { section: 'famelack', subGroup: gt }

  // Music
  if (g.includes('music') || g.includes('stingray')) return { section: 'music', subGroup: gt }

  // SportsTribal
  if (g.includes('sportstribal')) return { section: 'sports-other', subGroup: 'Sports - Other' }

  // Platform groups that are US-centric
  if (g === 'samsungtvplus - united states' || g === 'samsungtvplus - canada' || g === 'samsungtvplus - united kingdom') {
    if (g.includes('united states')) return { section: 'us', subGroup: gt }
    if (g.includes('canada')) return { section: 'canada', subGroup: gt }
    if (g.includes('united kingdom')) return { section: 'uk', subGroup: gt }
  }

  if (g === 'plutotv - united states') return { section: 'us', subGroup: gt }
  if (g === 'plextv - united states') return { section: 'us', subGroup: gt }
  if (g === 'plextv - canada') return { section: 'canada', subGroup: gt }
  if (g === 'plextv - united kingdom') return { section: 'uk', subGroup: gt }
  if (g === 'roku tv - united states') return { section: 'us', subGroup: gt }

  // Groups like PlexTV - United States, etc.
  if (g.includes('plextv') || g.includes('samsungtvplus') || g.includes('plutotv') || g.includes('roku')) {
    if (g.includes('united states') || g.includes('us') || g.includes('america')) return { section: 'us', subGroup: gt }
    if (g.includes('united kingdom') || g.includes('uk')) return { section: 'uk', subGroup: gt }
    if (g.includes('canada') || g.includes('ca')) return { section: 'canada', subGroup: gt }
    return { section: 'us', subGroup: gt }
  }

  // Platform/service groups default to US
  const usPlatforms = ['tcl', 'xumo', 'tubi', 'stirr', 'distro', 'sofast', 'klowdtv', 'wowza', 'firetv', 'canelatv', 'uplynk', 'cineversetv', 'pbs', 'afrolandtv', 'glewedtv', 'malimartv', '30a', 'viz', 'frequency', 'wfmz', '3abn', 'amagi', 'vegasplus', 'local', 'cbsn']
  if (usPlatforms.some(p => g.includes(p))) return { section: 'us', subGroup: gt }

  // UDPTV, LGTV
  if (g === 'udptv' || g === 'lgtv') return { section: 'other', subGroup: gt }

  // Default
  return { section: 'other', subGroup: gt }
}

const SECTION_ORDER = [
  'sports-events',
  'sports-football',
  'sports-combat',
  'sports-motorsports',
  'sports-other',
  'news',
  'us',
  'canada',
  'uk',
  'localnow',
  'famelack',
  'drew',
  'music',
  'international',
  'adult',
  'other',
  'vod-movies',
  'vod-tv',
  'vod-other'
]

function updateExtinf(extinf: string, newGroupTitle: string): string {
  let updated = extinf.replace(/group-title="[^"]*"/, `group-title="${newGroupTitle}"`)
  return updated
}

async function main() {
  console.log('Reading input file...')
  const content = fs.readFileSync(INPUT, 'utf-8')

  const firstLine = content.split('\n')[0].trimEnd()
  const header = firstLine.startsWith('#EXTM3U') ? firstLine : '#EXTM3U x-tvg-url="Robbdeeze_UltimateTV_Epg.xml.gz"'

  console.log('Parsing entries...')
  const entries = parseEntries(content)
  console.log(`Parsed ${entries.length} entries`)

  console.log('Classifying entries...')
  const classified = entries.map(e => {
    const { section, subGroup } = classify(e.groupTitle, e.title)
    return { ...e, section, newGroupTitle: subGroup }
  })

  // Group TV shows by show for better organization
  const tvShowGroups: Map<string, typeof classified> = new Map()
  const standaloneTv: typeof classified = []

  for (const e of classified) {
    if (e.section === 'vod-tv') {
      const key = e.newGroupTitle
      if (!tvShowGroups.has(key)) tvShowGroups.set(key, [])
      tvShowGroups.get(key)!.push(e)
    }
  }

  // Get show count for each group, but keep VOD - TV Shows - Other
  const filteredTvGroups = new Map<string, typeof classified>()
  let otherTv: typeof classified = []

  for (const [key, group] of tvShowGroups) {
    if (key === 'VOD - TV Shows - Other') {
      otherTv = group
      continue
    }
    if (key.startsWith('VOD - TV Shows - ')) {
      filteredTvGroups.set(key, group)
    } else {
      otherTv = [...otherTv, ...group]
    }
  }

  // Rebuild classified with proper ordering
  const sections: Record<string, typeof classified> = {}
  for (const sec of SECTION_ORDER) sections[sec] = []

  for (const e of classified) {
    if (e.section === 'vod-tv') continue // handled separately
    if (sections[e.section]) {
      sections[e.section].push(e)
    } else {
      sections['other'].push(e)
    }
  }

  // Add TV show groups
  const sortedShowKeys = [...filteredTvGroups.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  for (const key of sortedShowKeys) {
    sections['vod-tv'].push(...filteredTvGroups.get(key)!)
  }
  if (otherTv.length > 0) {
    sections['vod-tv'].push(...otherTv)
  }

  // Section sort functions
  const sortBySubGroupThenTitle = (a: typeof classified[0], b: typeof classified[0]) => {
    const ag = a.newGroupTitle.toLowerCase()
    const bg = b.newGroupTitle.toLowerCase()
    if (ag !== bg) return ag.localeCompare(bg)
    return a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  }

  const sortByTitle = (a: typeof classified[0], b: typeof classified[0]) => {
    return a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  }

  const sectionSort: Record<string, (a: typeof classified[0], b: typeof classified[0]) => number> = {
    'sports-events': sortByTitle,
    'sports-football': sortByTitle,
    'sports-combat': sortByTitle,
    'sports-motorsports': sortByTitle,
    'sports-other': sortBySubGroupThenTitle,
    'news': sortByTitle,
    'us': sortBySubGroupThenTitle,
    'canada': sortBySubGroupThenTitle,
    'uk': sortBySubGroupThenTitle,
    'localnow': sortByTitle,
    'famelack': sortByTitle,
    'drew': sortBySubGroupThenTitle,
    'music': sortByTitle,
    'international': sortBySubGroupThenTitle,
    'adult': sortByTitle,
    'other': sortBySubGroupThenTitle,
    'vod-movies': sortByTitle,
    'vod-tv': sortBySubGroupThenTitle,
    'vod-other': sortByTitle,
  }

  for (const sec of SECTION_ORDER) {
    if (sections[sec] && sectionSort[sec]) {
      sections[sec].sort(sectionSort[sec])
    }
  }

  const sectionCounts: Record<string, number> = {}
  for (const sec of SECTION_ORDER) {
    sectionCounts[sec] = sections[sec]?.length || 0
  }
  console.log('Section counts:', sectionCounts)

  console.log('Building output...')
  const outputLines: string[] = []
  outputLines.push(header)
  outputLines.push(`# Cleaned and reorganized by OpenCode on 2026-06-27`)
  outputLines.push(`# Total entries: ${entries.length}`)
  outputLines.push(`# Sports Events: ${sections['sports-events'].length} | Sports Football: ${sections['sports-football'].length} | Sports Combat: ${sections['sports-combat'].length} | Sports Motorsports: ${sections['sports-motorsports'].length} | Sports Other: ${sections['sports-other'].length}`)
  outputLines.push(`# News: ${sections['news'].length} | US: ${sections['us'].length} | Canada: ${sections['canada'].length} | UK: ${sections['uk'].length} | LocalNow: ${sections['localnow'].length}`)
  outputLines.push(`# VOD Movies: ${sections['vod-movies'].length} | VOD TV Shows: ${sections['vod-tv'].length}`)
  outputLines.push('')

  let writtenCount = 0
  for (const sec of SECTION_ORDER) {
    const groupEntries = sections[sec]
    if (!groupEntries || groupEntries.length === 0) continue

    for (const e of groupEntries) {
      const updatedExtinf = updateExtinf(e.extinf, e.newGroupTitle)
      outputLines.push(updatedExtinf)
      outputLines.push(e.url)
      writtenCount++
    }
  }

  const output = outputLines.join('\n') + '\n'
  fs.writeFileSync(OUTPUT, output, 'utf-8')

  console.log(`\nDone! Wrote ${writtenCount} entries to ${OUTPUT}`)
  const outputSize = fs.statSync(OUTPUT).size
  console.log(`Output size: ${(outputSize / 1024 / 1024).toFixed(2)} MB`)
}

main().catch(console.error)
