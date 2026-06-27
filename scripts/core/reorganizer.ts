import { Collection } from '@freearhey/core'
import { Stream } from '../models'

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

function extractShowName(raw: string): string | null {
  let t = raw.trim()
  t = t.replace(/^\[[^\]]*\]\s*/, '')
  t = t.replace(/^\[[^\]]*\]\./, '')
  t = t.replace(/\s*\[[A-F0-9]{8}\]\.\w{3,4}$/, '')
  t = t.replace(/\.\d{3,4}p\..*$/, '')
  const m = t.match(/^(.+?)\s+S\d+E\d+/)
  if (m) {
    let name = m[1].trim()
    name = name.replace(/\./g, ' ')
    name = name.replace(/\s+/g, ' ')
    return name
  }
  const m2 = t.match(/^(.+?)\s+S\d+/)
  if (m2) {
    let name = m2[1].trim()
    name = name.replace(/\./g, ' ')
    name = name.replace(/\s+/g, ' ')
    return name
  }
  return null
}

function classifyStream(stream: Stream): { section: string; subGroup: string } {
  const gt = (stream.groupTitle || '').toLowerCase().trim()
  const title = stream.title || ''

  if (gt.startsWith('vod -')) {
    if (gt.includes('tv shows') || gt.includes('tv_shows')) {
      const showName = extractShowName(title)
      if (showName) return { section: 'vod-tv', subGroup: `VOD - TV Shows - ${showName}` }
      return { section: 'vod-tv', subGroup: 'VOD - TV Shows - Other' }
    }
    if (gt.includes('movies') || gt.includes('movie')) return { section: 'vod-movies', subGroup: 'VOD - Movies' }
    return { section: 'vod-other', subGroup: stream.groupTitle }
  }

  // Sports scraper channels
  if (gt.includes('! sports -')) {
    return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
  }

  // PowerSports / StreamBTW / StreamEast / Roxiestream
  if (gt.includes('powersports') || gt.includes('streambtw') || gt.includes('streameast') || gt.includes('roxies') || gt.includes('roxiestream')) {
    if (gt.includes('ufc') || gt.includes('mma') || gt.includes('boxing') || gt.includes('fighting')) {
      return { section: 'sports-combat', subGroup: 'Sports - Combat / Fighting' }
    }
    if (gt.includes('formula') || gt.includes('f1') || gt.includes('motorsports') || gt.includes('racing') || gt.includes('nascar')) {
      return { section: 'sports-motorsports', subGroup: 'Sports - Motorsports / Racing' }
    }
    if (gt.includes('epl') || gt.includes('premier league') || gt.includes('soccer')) {
      return { section: 'sports-football', subGroup: 'Sports - Football' }
    }
    if (gt.includes('live event') || gt.includes('ppv') || gt.includes('live games') || gt.includes('live sports')) {
      return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
    }
    return { section: 'sports-other', subGroup: 'Sports - Other' }
  }

  // MLB/NHL/OnHockey webcast
  if (gt.includes('mlbwebcast') || gt.includes('nhlwebcast') || gt.includes('onhockey')) {
    return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
  }

  // A1xmedia
  if (gt.startsWith('a1xmedia')) {
    if (gt.includes('epl')) return { section: 'sports-football', subGroup: 'Sports - Football' }
    if (gt.includes('live event') || gt.includes('ppv')) return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
    if (gt.includes('uhd') || gt.includes('4k')) return { section: 'sports-other', subGroup: 'Sports - Other (UHD/4K)' }
    if (gt.includes('sports')) return { section: 'sports-other', subGroup: 'Sports - Other' }
    if (gt.includes('channel')) return { section: 'other', subGroup: stream.groupTitle }
    return { section: 'other', subGroup: stream.groupTitle }
  }

  // TimStreams
  if (gt.startsWith('timstreams')) {
    if (gt.includes('event')) return { section: 'sports-events', subGroup: 'Sports - Live / PPV / Events' }
    return { section: 'other', subGroup: stream.groupTitle }
  }

  // News
  if (gt === 'news' || gt.includes('cbsn') || gt.includes('abcnews')) {
    return { section: 'news', subGroup: 'News' }
  }

  // US groups
  if (gt === 'united states' || gt.startsWith('us -') || gt.startsWith('us_')) {
    return { section: 'us', subGroup: stream.groupTitle }
  }

  // Canada
  if (gt === 'canada' || gt.startsWith('ca -') || gt.startsWith('ca_')) {
    return { section: 'canada', subGroup: stream.groupTitle }
  }

  // UK groups
  if (gt === 'united kingdom' || gt.startsWith('uk -') || gt.startsWith('uk_')) {
    return { section: 'uk', subGroup: stream.groupTitle }
  }

  // LocalNow
  if (gt === 'localnow') return { section: 'localnow', subGroup: 'LocalNow' }

  // Drew
  if (gt.startsWith('drewlive') || gt.startsWith('drewfx')) return { section: 'drew', subGroup: stream.groupTitle }

  // YueChan
  if (gt.includes('yuechan')) return { section: 'international', subGroup: stream.groupTitle }

  // IPTVjs
  if (gt.includes('iptvjs')) return { section: 'adult', subGroup: stream.groupTitle }

  // Famelack
  if (gt.includes('famelack')) return { section: 'famelack', subGroup: stream.groupTitle }

  // Music
  if (gt.includes('music') || gt.includes('stingray')) return { section: 'music', subGroup: stream.groupTitle }

  // SportsTribal
  if (gt.includes('sportstribal')) return { section: 'sports-other', subGroup: 'Sports - Other' }

  // Platform groups by country
  if (gt.includes('plextv') || gt.includes('samsungtvplus') || gt.includes('plutotv') || gt.includes('roku')) {
    if (gt.includes('united states') || gt.includes('us') || gt.includes('america')) return { section: 'us', subGroup: stream.groupTitle }
    if (gt.includes('united kingdom') || gt.includes('uk')) return { section: 'uk', subGroup: stream.groupTitle }
    if (gt.includes('canada') || gt.includes('ca')) return { section: 'canada', subGroup: stream.groupTitle }
    return { section: 'us', subGroup: stream.groupTitle }
  }

  // US-centric platforms
  const usPlatforms = ['tcl', 'xumo', 'tubi', 'stirr', 'distro', 'sofast', 'klowdtv', 'wowza', 'firetv', 'canelatv', 'uplynk', 'cineversetv', 'pbs', 'afrolandtv', 'glewedtv', 'malimartv', '30a', 'viz', 'frequency', 'wfmz', '3abn', 'amagi', 'vegasplus', 'local', 'cbsn']
  if (usPlatforms.some(p => gt.includes(p))) return { section: 'us', subGroup: stream.groupTitle }

  if (gt === 'udptv' || gt === 'lgtv') return { section: 'other', subGroup: stream.groupTitle }

  return { section: 'other', subGroup: stream.groupTitle }
}

export function reorganizeStreams(streams: Collection<Stream>): Collection<Stream> {
  const items = streams.all()
  const sectionIndex = new Map(SECTION_ORDER.map((s, i) => [s, i]))

  // Annotate each stream with classification
  const annotated = items.map(s => {
    const { section, subGroup } = classifyStream(s)
    return { stream: s, section, subGroup }
  })

  // Update groupTitle on each stream
  for (const a of annotated) {
    a.stream.groupTitle = a.subGroup
  }

  // Sort by section order, then by subGroup, then by title
  annotated.sort((a, b) => {
    const siA = sectionIndex.get(a.section) ?? 999
    const siB = sectionIndex.get(b.section) ?? 999
    if (siA !== siB) return siA - siB

    const sgA = a.subGroup.toLowerCase()
    const sgB = b.subGroup.toLowerCase()
    if (sgA !== sgB) return sgA.localeCompare(sgB)

    const tA = (a.stream.title || '').toLowerCase()
    const tB = (b.stream.title || '').toLowerCase()
    return tA.localeCompare(tB)
  })

  return new Collection(annotated.map(a => a.stream))
}
