import { ROOT_DIR, STREAMS_DIR } from '../../constants'
import { Storage } from '@freearhey/storage-js'
import { Logger, Collection } from '@freearhey/core'
import { Stream, Playlist } from '../../models'
import iptvParser from 'iptv-playlist-parser'
import path from 'node:path'
import fs from 'node:fs'

function getGroupTitle(filename: string): string {
  const nameWithoutExt = filename.replace(/\.m3u$/i, '')
  const parts = nameWithoutExt.split('_')
  const country = parts[0].toUpperCase()
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

  // Step 2: Parse VOD files
  const vodFiles: { filepath: string; groupTitle: string }[] = [
    { filepath: "/Users/robbdeeze/Documents/Movies:TV with Posters_LiveTV M3U's /movies_organized_poster_groups102925.m3u", groupTitle: 'VOD - Movies' },
    { filepath: "/Users/robbdeeze/Documents/Movies:TV with Posters_LiveTV M3U's /tv shows with posters.m3u", groupTitle: 'VOD - TV Shows' }
  ]

  for (const { filepath: vodPath, groupTitle } of vodFiles) {
    logger.info(`reading VOD: ${vodPath} -> "${groupTitle}"...`)
    try {
      const content = fs.readFileSync(vodPath, 'utf8')
      const parsed: iptvParser.Playlist = iptvParser.parse(content)
      for (const item of parsed.items) {
        const stream = Stream.fromPlaylistItem(item)
        stream.groupTitle = groupTitle
        if (!seenUrls.has(stream.url)) {
          seenUrls.add(stream.url)
          streams.push(stream)
        }
      }
      const count = parsed.items.length
      logger.info(`  added ${count} streams`)
    } catch (err) {
      logger.error(`  failed: ${err}`)
    }
  }

  logger.info(`total streams before dedup: ${streams.length}`)

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
