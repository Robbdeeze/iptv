import { ROOT_DIR, STREAMS_DIR } from '../../constants'
import { Storage } from '@freearhey/storage-js'
import { PlaylistParser } from '../../core'
import { loadData, data } from '../../api'
import { Logger } from '@freearhey/core'
import { Stream, Playlist } from '../../models'
import iptvParser from 'iptv-playlist-parser'
import { Collection } from '@freearhey/core'
import { eachLimit } from 'async'
import { scrapeDaddylive } from './daddyliveScraper'
import { scrapeStreamed } from './streamedScraper'
import { scrapeNtv } from './ntvScraper'
import { scrapeSportsBite } from './sportsBiteScraper'
import { scrapePpvTo } from './ppvToScraper'
import { scrapeRoxie } from './roxieScraper'
import { scrapeSportyHunter } from './sportyHunterScraper'
import { scrapeVipbox } from './vipboxScraper'
import { scrapeSportsurge } from './sportsurgeScraper'
import { scrapeStreamEast } from './streamEastScraper'
import { scrapeLiveTV } from './liveTvScraper'
import { scrapeSportsHD } from './sportshdScraper'
import { closeBrowser, reorganizeStreams } from '../../core'
import path from 'node:path'
import fs from 'node:fs'
import axios from 'axios'
import zlib from 'node:zlib'

const SCRAPER_TIMEOUT = 5 * 60 * 1000 // 5 minutes per scraper
const GLOBAL_TIMEOUT = 55 * 60 * 1000  // 55 minutes total

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    )
  ])
}

function getGroupTitle(filename: string): string {
  const nameWithoutExt = filename.replace(/\.m3u$/i, '')
  const parts = nameWithoutExt.split('_')
  const country = parts[0].toUpperCase() // 'US', 'CA', or 'UK'
  if (parts.length === 1) {
    const countryNames: { [key: string]: string } = {
      US: 'United States',
      CA: 'Canada',
      UK: 'United Kingdom'
    }
    return countryNames[country] || country
  }
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
  return `${country} - ${capitalizedSource}`
}

async function main() {
  const logger = new Logger()

  logger.info('loading data from api...')
  await loadData()

  logger.info('loading streams...')
  const streamsStorage = new Storage(STREAMS_DIR)
  const parser = new PlaylistParser({
    storage: streamsStorage
  })

  // List all m3u files under streams/
  const files = await streamsStorage.list('**/*.m3u')
  
  // Filter for US, CA, UK files (case-insensitive), excluding auto-generated famelack files
  const targetFiles = files.filter(filepath => {
    const filename = path.basename(filepath).toLowerCase()
    if (filename.includes('famelack')) return false
    return filename.startsWith('us') || filename.startsWith('ca') || filename.startsWith('uk')
  })

  logger.info(`found ${targetFiles.length} matching m3u files`)

  // External playlists to fetch and include
  const externalPlaylists: { url: string; groupTitle: string }[] = [
    { url: 'https://raw.githubusercontent.com/YueChan/Live/main/Global.m3u', groupTitle: 'YueChan - Global' },
    { url: 'https://raw.githubusercontent.com/YueChan/Live/main/Radio.m3u', groupTitle: 'YueChan - Radio' },
    { url: 'http://drewlive2423.duckdns.org:8045/DrewLive/DrewLiveMergedPlaylist.m3u8', groupTitle: '' }
  ]

  const allExternalStreams: { groupTitle: string; streams: Stream[] }[] = []

  const allowedCountries = new Set(['United States', 'United Kingdom', 'Canada', 'US', 'UK', 'CA'])

  function keepStream(stream: Stream): boolean {
    const gt = String(stream.groupTitle || '')
    for (const prefix of ['PlutoTV - ', 'SamsungTVPlus - ', 'PlexTV - ']) {
      if (gt.startsWith(prefix)) {
        const country = gt.slice(prefix.length)
        if (!allowedCountries.has(country)) return false
      }
    }
    return true
  }

  for (const { url, groupTitle } of externalPlaylists) {
    logger.info(`fetching external playlist: ${url}...`)
    try {
      const response = await axios.get(url, { timeout: 15000 })
      const parsed: iptvParser.Playlist = iptvParser.parse(response.data)
      let streams = parsed.items.map((item: iptvParser.PlaylistItem) =>
        Stream.fromPlaylistItem(item)
      )
      if (!groupTitle) {
        const before = streams.length
        streams = streams.filter(keepStream)
        const removed = before - streams.length
        if (removed > 0) logger.info(`filtered out ${removed} streams (non-US/UK/CA PlutoTV/SamsungTVPlus/PlexTV)`)
      }
      allExternalStreams.push({ groupTitle, streams })
      logger.info(`loaded ${streams.length} streams from ${url} -> group: "${groupTitle}"`)
    } catch (err) {
      logger.error(`failed to fetch ${url}: ${err}`)
    }
  }

  // Note: VOD is no longer embedded in the main playlist.
  // VOD playlists are available separately under streams/vod/:
  //   - streams/vod/movies.m3u
  //   - streams/vod/tv-shows.m3u

  // Famelack data: fetch US/UK channel JSON, convert to M3U, and save to streams/
  const famelackSources: { countryCode: string; groupTitle: string }[] = [
    { countryCode: 'us', groupTitle: 'Famelack - US' },
    { countryCode: 'uk', groupTitle: 'Famelack - UK' }
  ]

  const allFamelackStreams: { groupTitle: string; streams: Stream[] }[] = []

  for (const { countryCode, groupTitle } of famelackSources) {
    const url = `https://raw.githubusercontent.com/famelack/famelack-data/main/tv/raw/countries/${countryCode}.json`
    logger.info(`fetching famelack ${countryCode} channels...`)
    try {
      const response = await axios.get(url, { timeout: 30000 })
      const channels: any[] = response.data
      const streams: Stream[] = []
      let m3uContent = '#EXTM3U\r\n'

      for (const ch of channels) {
        const streamUrls = ch.sources?.streams
        if (!streamUrls || !streamUrls.length) continue

        for (const streamUrl of streamUrls) {
          const tvgId = ch.nanoid || ''
          const name = ch.name || 'Unknown'
          m3uContent += `#EXTINF:-1 tvg-id="${tvgId}" group-title="${groupTitle}",${name}\r\n${streamUrl}\r\n`

          const stream = new Stream({
            channel: tvgId,
            title: name,
            url: streamUrl,
            quality: null,
            referrer: null,
            user_agent: null,
            label: null,
            feed: null
          })
          stream.groupTitle = groupTitle
          streams.push(stream)
        }
      }

      // Save individual M3U file to streams/generated/ folder
      const m3uFilename = `${countryCode}_famelack.m3u`
      const m3uFilepath = path.join(STREAMS_DIR, 'generated', m3uFilename)
      fs.writeFileSync(m3uFilepath, m3uContent)
      logger.info(`saved ${streams.length} streams to streams/${m3uFilename}`)

      allFamelackStreams.push({ groupTitle, streams })
      logger.info(`loaded ${streams.length} streams from famelack ${countryCode}`)
    } catch (err) {
      logger.error(`failed to fetch famelack ${countryCode}: ${err}`)
    }
  }

  let combinedStreams = new Collection<Stream>()

  for (const filepath of targetFiles) {
    const filename = path.basename(filepath)
    const groupTitle = getGroupTitle(filename)
    logger.info(`parsing ${filename} -> group: "${groupTitle}"...`)

    // Parse streams from this file
    const fileStreams = await parser.parseFile(filepath)
    fileStreams.forEach((stream: Stream) => {
      // Set guide info
      stream.setGuides(data.guidesGroupedByStreamId.get(stream.getId()))
      // Set custom group title
      stream.groupTitle = groupTitle
      combinedStreams.add(stream)
    })
  }

  // Add all external streams with their group-titles
  for (const { groupTitle, streams } of allExternalStreams) {
    logger.info(`adding ${streams.length} streams to group "${groupTitle || '(from file)'}"...`)
    streams.forEach((stream: Stream) => {
      stream.setGuides(data.guidesGroupedByStreamId.get(stream.getId()))
      if (groupTitle) stream.groupTitle = groupTitle
      combinedStreams.add(stream)
    })
  }
  if (allExternalStreams.length) {
    logger.info(`total streams after external additions: ${combinedStreams.count()}`)
  }

  // VOD is no longer embedded here — available separately in streams/vod/

  // Add all famelack streams
  for (const { groupTitle, streams } of allFamelackStreams) {
    logger.info(`adding ${streams.length} streams to group "${groupTitle}"...`)
    streams.forEach((stream: Stream) => {
      combinedStreams.add(stream)
    })
  }
  if (allFamelackStreams.length) {
    logger.info(`total streams after famelack additions: ${combinedStreams.count()}`)
  }

  // Run all sports scrapers in parallel (with individual timeouts)
  logger.info('scraping all sports streams (parallel)...')
  const scraperResults = await Promise.allSettled([
    withTimeout(scrapeDaddylive(logger), SCRAPER_TIMEOUT, 'DaddyLive'),
    withTimeout(scrapeStreamed(logger), SCRAPER_TIMEOUT, 'Streamed'),
    withTimeout(scrapeNtv(logger), SCRAPER_TIMEOUT, 'NTV'),
    withTimeout(scrapeSportsBite(logger), SCRAPER_TIMEOUT, 'SportsBite'),
    withTimeout(scrapePpvTo(logger), SCRAPER_TIMEOUT, 'PPV.TO'),
    withTimeout(scrapeRoxie(logger), SCRAPER_TIMEOUT, 'Roxie'),
    withTimeout(scrapeSportyHunter(logger), SCRAPER_TIMEOUT, 'SportyHunter'),
    withTimeout(scrapeVipbox(logger), SCRAPER_TIMEOUT, 'VIPRow'),
    withTimeout(scrapeSportsurge(logger), SCRAPER_TIMEOUT, 'Sportsurge'),
    withTimeout(scrapeStreamEast(logger), SCRAPER_TIMEOUT, 'StreamEast'),
    withTimeout(scrapeLiveTV(logger), SCRAPER_TIMEOUT, 'LiveTV'),
    withTimeout(scrapeSportsHD(logger), SCRAPER_TIMEOUT, 'SportsHD')
  ])

  const scraperNames = ['DaddyLive', 'Streamed', 'NTV', 'SportsBite', 'PPV.TO', 'Roxie', 'SportyHunter', 'VIPRow', 'Sportsurge', 'StreamEast', 'LiveTV', 'SportsHD']
  for (let i = 0; i < scraperResults.length; i++) {
    const result = scraperResults[i]
    if (result.status === 'rejected') {
      logger.error(`${scraperNames[i]} scraper failed: ${result.reason}`)
      continue
    }
    const streamsList = result.value
    for (const { groupTitle, streams } of streamsList) {
      logger.info(`adding ${streams.length} streams to group "${groupTitle}"...`)
      streams.forEach((stream: Stream) => {
        combinedStreams.add(stream)
      })
    }
  }

  await closeBrowser()
  logger.info(`loaded ${combinedStreams.count()} total streams`)

  // Deduplicate streams by URL
  logger.info('deduplicating streams by URL...')
  combinedStreams = combinedStreams.uniqBy((stream: Stream) => stream.url)

  logger.info(`retained ${combinedStreams.count()} streams after deduplication`)

  // Reorganize: reclassify group-titles and reorder into clean categories
  logger.info('reorganizing streams into clean categories...')
  combinedStreams = reorganizeStreams(combinedStreams)

  logger.info(`reorganized ${combinedStreams.count()} streams`)

  // Write playlist to the root directory
  logger.info('generating Robbdeeze_UltimateTV.m3u...')
  const rootStorage = new Storage(ROOT_DIR)
  const playlist = new Playlist(combinedStreams, { public: true })
  
  let playlistString = playlist.toString()
  // Replace the first line to point to our generated Robbdeeze_UltimateTV_Epg.xml.gz
  const firstLineEnd = playlistString.indexOf('\r\n')
  if (firstLineEnd !== -1) {
    playlistString = '#EXTM3U x-tvg-url="Robbdeeze_UltimateTV_Epg.xml.gz"' + playlistString.substring(firstLineEnd)
  }

  await rootStorage.save('Robbdeeze_UltimateTV.m3u', playlistString)
  logger.info('playlist generated successfully.')

  // Generate EPG XMLTV file
  logger.info('collecting target tvg-ids for EPG...')
  const targetTvgIds = new Set<string>()
  combinedStreams.forEach((stream: Stream) => {
    const tvgId = stream.getTvgId()
    if (tvgId) {
      targetTvgIds.add(tvgId)
    }
  })

  logger.info(`found ${targetTvgIds.size} unique channel tvg-ids for EPG`)

  const guideUrls = playlist.getGuideUrls().all()
  logger.info(`found ${guideUrls.length} unique guide source URLs`)

  const matchedChannels = new Set<string>()
  const matchedProgrammes = new Set<string>()

  // Download and extract EPGs in parallel with a concurrency of 3
  await new Promise<void>((resolve) => {
    eachLimit(
      guideUrls,
      3, // Concurrency limit
      async (url: string) => {
        try {
          logger.info(`downloading EPG from ${url}...`)
          const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Accept-Encoding': 'gzip, deflate, br'
            }
          })

          let xml = ''
          const buffer = Buffer.from(response.data)
          const contentEncoding = response.headers['content-encoding'] || ''

          if (url.endsWith('.gz') || contentEncoding.includes('gzip')) {
            xml = zlib.gunzipSync(buffer).toString('utf8')
          } else {
            xml = buffer.toString('utf8')
          }

          logger.info(`parsing EPG content from ${url} (${(xml.length / 1024 / 1024).toFixed(2)} MB)...`)

          // Match channels
          const channelRegex = /<channel\s+[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/channel>/gi
          let match
          let channelCount = 0
          while ((match = channelRegex.exec(xml)) !== null) {
            const tvgId = match[1]
            if (targetTvgIds.has(tvgId)) {
              matchedChannels.add(match[0])
              channelCount++
            }
          }

          // Match programmes
          const programmeRegex = /<programme\s+[^>]*channel=["']([^"']+)["'][^>]*>([\s\S]*?)<\/programme>/gi
          let programmeCount = 0
          while ((match = programmeRegex.exec(xml)) !== null) {
            const tvgId = match[1]
            if (targetTvgIds.has(tvgId)) {
              matchedProgrammes.add(match[0])
              programmeCount++
            }
          }

          logger.info(`extracted ${channelCount} channels and ${programmeCount} programmes from ${url}`)
        } catch (err: any) {
          logger.error(`failed to process EPG from ${url}: ${err.message || err}`)
        }
      },
      (err) => {
        if (err) logger.error(`error during EPG compilation: ${err}`)
        resolve()
      }
    )
  })

  logger.info('compiling Robbdeeze_UltimateTV_Epg.xml...')
  let xmltv = '<?xml version="1.0" encoding="UTF-8"?>\n'
  xmltv += '<tv generator-info-name="Robbdeeze UltimateTV EPG Generator">\n'
  
  matchedChannels.forEach((channelXml) => {
    xmltv += '  ' + channelXml + '\n'
  })
  
  matchedProgrammes.forEach((programmeXml) => {
    xmltv += '  ' + programmeXml + '\n'
  })
  
  xmltv += '</tv>\n'

  await rootStorage.save('Robbdeeze_UltimateTV_Epg.xml', xmltv)

  // Compress to .gz
  logger.info('compressing EPG to Robbdeeze_UltimateTV_Epg.xml.gz...')
  const gzipped = zlib.gzipSync(Buffer.from(xmltv, 'utf8'))
  await rootStorage.save('Robbdeeze_UltimateTV_Epg.xml.gz', gzipped)

  logger.info('done! EPG and playlist generated successfully.')
}

withTimeout(main(), GLOBAL_TIMEOUT, 'Ultimate playlist generation').then(() => {
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
