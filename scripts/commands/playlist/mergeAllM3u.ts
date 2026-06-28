import { ROOT_DIR, STREAMS_DIR } from '../../constants'
import { Storage } from '@freearhey/storage-js'
import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import iptvParser from 'iptv-playlist-parser'
import path from 'node:path'
import fs from 'node:fs'
import axios from 'axios'

const COUNTRY_NAMES: Record<string, string> = {
  AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan', AG: 'Antigua and Barbuda',
  AL: 'Albania', AM: 'Armenia', AO: 'Angola', AR: 'Argentina', AT: 'Austria',
  AU: 'Australia', AW: 'Aruba', AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina',
  BB: 'Barbados', BD: 'Bangladesh', BE: 'Belgium', BF: 'Burkina Faso', BG: 'Bulgaria',
  BH: 'Bahrain', BI: 'Burundi', BJ: 'Benin', BM: 'Bermuda', BN: 'Brunei', BO: 'Bolivia',
  BQ: 'Bonaire', BR: 'Brazil', BS: 'Bahamas', BW: 'Botswana', BY: 'Belarus', BZ: 'Belize',
  CA: 'Canada', CD: 'DR Congo', CF: 'Central African Republic', CG: 'Congo',
  CH: 'Switzerland', CI: 'Côte d\'Ivoire', CL: 'Chile', CM: 'Cameroon', CN: 'China',
  CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CV: 'Cape Verde', CW: 'Curaçao',
  CY: 'Cyprus', CZ: 'Czech Republic', DE: 'Germany', DJ: 'Djibouti', DK: 'Denmark',
  DM: 'Dominica', DO: 'Dominican Republic', DZ: 'Algeria', EC: 'Ecuador', EE: 'Estonia',
  EG: 'Egypt', EH: 'Western Sahara', ER: 'Eritrea', ES: 'Spain', ET: 'Ethiopia',
  FI: 'Finland', FJ: 'Fiji', FM: 'Micronesia', FO: 'Faroe Islands', FR: 'France',
  GA: 'Gabon', GE: 'Georgia', GF: 'French Guiana', GH: 'Ghana', GL: 'Greenland',
  GM: 'Gambia', GN: 'Guinea', GP: 'Guadeloupe', GQ: 'Equatorial Guinea', GR: 'Greece',
  GT: 'Guatemala', GU: 'Guam', GY: 'Guyana', HK: 'Hong Kong', HN: 'Honduras',
  HR: 'Croatia', HT: 'Haiti', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland',
  IL: 'Israel', IN: 'India', IQ: 'Iraq', IR: 'Iran', IS: 'Iceland', IT: 'Italy',
  JM: 'Jamaica', JO: 'Jordan', JP: 'Japan', KE: 'Kenya', KG: 'Kyrgyzstan',
  KH: 'Cambodia', KM: 'Comoros', KN: 'Saint Kitts and Nevis', KP: 'North Korea',
  KR: 'South Korea', KW: 'Kuwait', KZ: 'Kazakhstan', LA: 'Laos', LB: 'Lebanon',
  LC: 'Saint Lucia', LI: 'Liechtenstein', LK: 'Sri Lanka', LR: 'Liberia',
  LS: 'Lesotho', LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya',
  MA: 'Morocco', MC: 'Monaco', MD: 'Moldova', ME: 'Montenegro', MG: 'Madagascar',
  MK: 'North Macedonia', ML: 'Mali', MM: 'Myanmar', MN: 'Mongolia', MO: 'Macau',
  MQ: 'Martinique', MR: 'Mauritania', MT: 'Malta', MU: 'Mauritius', MV: 'Maldives',
  MW: 'Malawi', MX: 'Mexico', MY: 'Malaysia', MZ: 'Mozambique', NA: 'Namibia',
  NE: 'Niger', NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway',
  NP: 'Nepal', NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru',
  PF: 'French Polynesia', PG: 'Papua New Guinea', PH: 'Philippines', PK: 'Pakistan',
  PL: 'Poland', PR: 'Puerto Rico', PS: 'Palestine', PT: 'Portugal', PY: 'Paraguay',
  QA: 'Qatar', RO: 'Romania', RS: 'Serbia', RU: 'Russia', RW: 'Rwanda',
  SA: 'Saudi Arabia', SD: 'Sudan', SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia',
  SK: 'Slovakia', SL: 'Sierra Leone', SM: 'San Marino', SN: 'Senegal', SO: 'Somalia',
  SR: 'Suriname', ST: 'São Tomé and Príncipe', SV: 'El Salvador', SX: 'Sint Maarten',
  SY: 'Syria', TD: 'Chad', TG: 'Togo', TH: 'Thailand', TJ: 'Tajikistan',
  TL: 'East Timor', TM: 'Turkmenistan', TN: 'Tunisia', TR: 'Turkey', TT: 'Trinidad and Tobago',
  TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine', UG: 'Uganda',
  UK: 'United Kingdom', US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan',
  VA: 'Vatican City', VE: 'Venezuela', VG: 'British Virgin Islands', VI: 'US Virgin Islands',
  VN: 'Vietnam', WS: 'Samoa', XK: 'Kosovo', YE: 'Yemen', YT: 'Mayotte',
  ZA: 'South Africa', ZM: 'Zambia', ZW: 'Zimbabwe'
}

function getGroupTitle(filename: string): string {
  const nameWithoutExt = filename.replace(/\.m3u$/i, '')
  const parts = nameWithoutExt.split('_')
  const countryCode = parts[0].toUpperCase()
  const countryName = COUNTRY_NAMES[countryCode] || countryCode

  if (parts.length === 1) return countryName

  const source = parts.slice(1).join(' ')
  const capitalizedSource = source
    .split(' ')
    .map(word => {
      const lower = word.toLowerCase()
      if (lower === 'tv') return 'TV'
      if (lower === 'bbc') return 'BBC'
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    })
    .join(' ')
  return `${countryName} - ${capitalizedSource}`
}

async function main() {
  const logger = new Logger()
  const streams: Stream[] = []
  const seenUrls = new Set<string>()

  // Step 1: Parse all M3U files from streams/ directory
  logger.info('parsing m3u files from streams/...')
  const streamsStorage = new Storage(STREAMS_DIR)
  const files = await streamsStorage.list('**/*.m3u')

  for (const filepath of files) {
    const filename = path.basename(filepath)
    const groupTitle = getGroupTitle(filename)
    logger.info(`  ${filename} -> "${groupTitle}"`)

    const fullPath = path.join(STREAMS_DIR, filepath)
    const content = fs.readFileSync(fullPath, 'utf8')
    const parsed: iptvParser.Playlist = iptvParser.parse(content)

    for (const item of parsed.items) {
      const stream = Stream.fromPlaylistItem(item)
      stream.groupTitle = groupTitle
      if (!seenUrls.has(stream.url)) {
        seenUrls.add(stream.url)
        streams.push(stream)
      }
    }
  }

  logger.info(`loaded ${streams.length} streams from streams/`)

  // Note: VOD is no longer embedded in the merged playlist.
  // VOD playlists are available separately under streams/vod/:
  //   - streams/vod/movies.m3u
  //   - streams/vod/tv-shows.m3u

  logger.info(`total streams: ${streams.length}`)

  // Step 3: Sort
  logger.info('sorting...')
  const sorted = [...streams].sort((a, b) => {
    const g = (a.groupTitle || '').localeCompare(b.groupTitle || '')
    if (g !== 0) return g
    const t = (a.title || '').localeCompare(b.title || '')
    if (t !== 0) return t
    return (b.getVerticalResolution() || 0) - (a.getVerticalResolution() || 0)
  })

  // Step 4: Write playlist
  logger.info('generating Robbdeeze_UltimateTV_AllM3uMerged.m3u...')
  const rootStorage = new Storage(ROOT_DIR)

  // Build M3U manually to avoid Playlist class Collection dependency
  let m3u = '#EXTM3U\r\n'
  for (const stream of sorted) {
    const tvgId = stream.getTvgId() || ''
    const tvgLogo = stream.getTvgLogo() || ''
    const groupTitle = stream.groupTitle || ''
    const title = stream.title || ''
    m3u += `#EXTINF:-1 tvg-id="${tvgId}" tvg-logo="${tvgLogo}" group-title="${groupTitle}",${title}\r\n${stream.url}\r\n`
  }

  await rootStorage.save('Robbdeeze_UltimateTV_AllM3uMerged.m3u', m3u)
  logger.info(`done! ${sorted.length} streams written.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
