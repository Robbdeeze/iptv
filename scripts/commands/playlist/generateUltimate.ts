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
import path from 'node:path'
import fs from 'node:fs'
import axios from 'axios'
import zlib from 'node:zlib'

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
    { url: 'https://raw.githubusercontent.com/iptvjs/iptv/main/adultiptv_all.m3u', groupTitle: 'IPTVjs - Adult' }
  ]

  let allExternalStreams: { groupTitle: string; streams: Stream[] }[] = []

  for (const { url, groupTitle } of externalPlaylists) {
    logger.info(`fetching external playlist: ${url}...`)
    try {
      const response = await axios.get(url, { timeout: 15000 })
      const parsed: iptvParser.Playlist = iptvParser.parse(response.data)
      const streams = parsed.items.map((item: iptvParser.PlaylistItem) =>
        Stream.fromPlaylistItem(item)
      )
      allExternalStreams.push({ groupTitle, streams })
      logger.info(`loaded ${streams.length} streams from ${url} -> group: "${groupTitle}"`)
    } catch (err) {
      logger.error(`failed to fetch ${url}: ${err}`)
    }
  }

  // Local VOD files to include
  const localPlaylists: { filepath: string; groupTitle?: string }[] = [
    { filepath: '/Users/robbdeeze/Documents/Movies:TV with Posters_LiveTV M3U\'s /movies_organized_poster_groups102925.m3u', groupTitle: 'VOD - Movies' },
    { filepath: '/Users/robbdeeze/Documents/Movies:TV with Posters_LiveTV M3U\'s /tv shows with posters.m3u', groupTitle: 'VOD - TV Shows' }
  ]

  let allLocalStreams: { groupTitle: string; streams: Stream[] }[] = []

  for (const { filepath: localPath, groupTitle: overrideGroup } of localPlaylists) {
    logger.info(`reading local playlist: ${localPath}...`)
    try {
      const content = fs.readFileSync(localPath, 'utf8')
      const parsed: iptvParser.Playlist = iptvParser.parse(content)
      const streams = parsed.items.map((item: iptvParser.PlaylistItem) => {
        const stream = Stream.fromPlaylistItem(item)
        stream.groupTitle = overrideGroup
        return stream
      })
      allLocalStreams.push({ groupTitle: overrideGroup || '', streams })
      logger.info(`loaded ${streams.length} streams from local file`)
    } catch (err) {
      logger.error(`failed to read local file ${localPath}: ${err}`)
    }
  }

  // Famelack data: fetch US/UK channel JSON, convert to M3U, and save to streams/
  const famelackSources: { countryCode: string; groupTitle: string }[] = [
    { countryCode: 'us', groupTitle: 'Famelack - US' },
    { countryCode: 'uk', groupTitle: 'Famelack - UK' }
  ]

  let allFamelackStreams: { groupTitle: string; streams: Stream[] }[] = []

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

      // Save individual M3U file to streams/ folder
      const m3uFilename = `${countryCode}_famelack.m3u`
      const m3uFilepath = path.join(STREAMS_DIR, m3uFilename)
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
    logger.info(`adding ${streams.length} streams to group "${groupTitle}"...`)
    streams.forEach((stream: Stream) => {
      stream.setGuides(data.guidesGroupedByStreamId.get(stream.getId()))
      stream.groupTitle = groupTitle
      combinedStreams.add(stream)
    })
  }
  if (allExternalStreams.length) {
    logger.info(`total streams after external additions: ${combinedStreams.count()}`)
  }

  // Add all local VOD streams (group-titles already set from source file)
  for (const { streams } of allLocalStreams) {
    logger.info(`adding ${streams.length} local VOD streams...`)
    streams.forEach((stream: Stream) => {
      stream.setGuides(data.guidesGroupedByStreamId.get(stream.getId()))
      combinedStreams.add(stream)
    })
  }
  if (allLocalStreams.length) {
    logger.info(`total streams after local VOD additions: ${combinedStreams.count()}`)
  }

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

  // Add daddylive sports streams
  logger.info('scraping daddylive sports streams...')
  const allDaddyliveStreams = await scrapeDaddylive(logger)
  for (const { groupTitle, streams } of allDaddyliveStreams) {
    logger.info(`adding ${streams.length} streams to group "${groupTitle}"...`)
    streams.forEach((stream: Stream) => {
      combinedStreams.add(stream)
    })
  }
  if (allDaddyliveStreams.length) {
    logger.info(`total streams after daddylive additions: ${combinedStreams.count()}`)
  }

  // Add streamed.pk sports streams
  logger.info('scraping streamed.pk sports streams...')
  const allStreamedStreams = await scrapeStreamed(logger)
  for (const { groupTitle, streams } of allStreamedStreams) {
    logger.info(`adding ${streams.length} streams to group "${groupTitle}"...`)
    streams.forEach((stream: Stream) => {
      combinedStreams.add(stream)
    })
  }
  if (allStreamedStreams.length) {
    logger.info(`total streams after streamed additions: ${combinedStreams.count()}`)
  }

  logger.info(`loaded ${combinedStreams.count()} total streams`)

  // Deduplicate streams by URL
  logger.info('deduplicating streams by URL...')
  combinedStreams = combinedStreams.uniqBy((stream: Stream) => stream.url)

  logger.info(`retained ${combinedStreams.count()} streams after deduplication`)

  // Sort streams: Group Title (asc), Title (asc), Resolution (desc)
  logger.info('sorting streams...')
  combinedStreams = combinedStreams.sortBy(
    [
      (stream: Stream) => stream.groupTitle,
      (stream: Stream) => stream.title,
      (stream: Stream) => stream.getVerticalResolution()
    ],
    ['asc', 'asc', 'desc']
  )

  // Write playlist to the root directory
  logger.info('generating Robbdeeze_UltimateTV.m3u...')
  const rootStorage = new Storage(ROOT_DIR)
  const playlist = new Playlist(combinedStreams, { public: true })
  
  let playlistString = playlist.toString()
  // Replace the first line to point to our generated Robbdeeze_UltimateTV_Epg.xml.gz
  const firstLineEnd = playlistString.indexOf('\r\n')
  if (firstLineEnd !== -1) {
    playlistString = `#EXTM3U x-tvg-url="Robbdeeze_UltimateTV_Epg.xml.gz"` + playlistString.substring(firstLineEnd)
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

main().catch(err => {
  console.error(err)
  process.exit(1)
})
