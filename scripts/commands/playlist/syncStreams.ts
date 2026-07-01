import { STREAMS_DIR } from '../../constants'
import { Storage } from '@freearhey/storage-js'
import { Logger } from '@freearhey/core'
import axios from 'axios'
import path from 'node:path'

const UPSTREAM_OWNER = 'iptv-org'
const UPSTREAM_REPO = 'iptv'
const UPSTREAM_BRANCH = 'master'
const API_URL = `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/contents/streams`
const RAW_BASE = `https://raw.githubusercontent.com/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/${UPSTREAM_BRANCH}/streams`

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'

const EXTERNAL_PLAYLISTS: { url: string; filename: string }[] = [
  { url: 'https://raw.githubusercontent.com/YueChan/Live/main/Global.m3u', filename: 'yuechan_global.m3u' },
  { url: 'https://raw.githubusercontent.com/YueChan/Live/main/Radio.m3u', filename: 'yuechan_radio.m3u' },
  { url: 'http://drewlive2423.duckdns.org:8045/DrewLive/DrewLiveMergedPlaylist.m3u8', filename: 'drewlive_merged.m3u8' },
]

const FAMELACK_SOURCES: { countryCode: string; filename: string }[] = [
  { countryCode: 'us', filename: 'us_famelack.m3u' },
  { countryCode: 'uk', filename: 'uk_famelack.m3u' },
]

async function downloadFile(url: string, logger: Logger): Promise<string | null> {
  try {
    const res = await axios.get(url, {
      timeout: 30000,
      headers: { 'User-Agent': UA }
    })
    return typeof res.data === 'string' ? res.data : String(res.data)
  } catch (err: unknown) {
    const msg = (err as { message?: string })?.message || String(err)
    logger.error(`  Download failed: ${msg.substring(0, 80)}`)
    return null
  }
}

async function syncIptvOrg(logger: Logger, storage: Storage): Promise<void> {
  logger.info('=== Syncing iptv-org/iptv streams ===')
  const res = await axios.get(API_URL, {
    timeout: 15000,
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }
  })

  const files: { name: string; type: string }[] = res.data
  const m3uFiles = files.filter(f => f.type === 'file' && f.name.endsWith('.m3u'))
  logger.info(`Found ${m3uFiles.length} M3U files upstream`)

  let downloaded = 0
  let skipped = 0

  for (const file of m3uFiles) {
    const name = file.name
    const isCountryFile = /^[a-z]{2}\.m3u$/.test(name)
    const subdir = isCountryFile ? 'countries' : 'sources'
    const url = `${RAW_BASE}/${name}`

    const content = await downloadFile(url, logger)
    if (content) {
      await storage.save(path.join(subdir, name), content)
      downloaded++
    } else {
      skipped++
    }
  }

  logger.info(`iptv-org: ${downloaded} downloaded, ${skipped} skipped`)
}

async function syncExternalPlaylists(logger: Logger, storage: Storage): Promise<void> {
  logger.info('=== Syncing external playlists ===')

  for (const { url, filename } of EXTERNAL_PLAYLISTS) {
    logger.info(`  Fetching ${filename} ...`)
    const content = await downloadFile(url, logger)
    if (content) {
      await storage.save(path.join('external', filename), content)
      logger.info(`  Saved streams/external/${filename}`)
    }
  }
}

async function syncFamelack(logger: Logger, storage: Storage): Promise<void> {
  logger.info('=== Syncing Famelack data ===')

  for (const { countryCode, filename } of FAMELACK_SOURCES) {
    const url = `https://raw.githubusercontent.com/famelack/famelack-data/main/tv/raw/countries/${countryCode}.json`
    logger.info(`  Fetching ${countryCode} channels from famelack ...`)

    try {
      const res = await axios.get(url, {
        timeout: 30000,
        headers: { 'User-Agent': UA }
      })
      const channels = res.data as { sources?: { streams?: string[] }; nanoid?: string; name?: string }[]
      if (!Array.isArray(channels)) {
        logger.error(`  Invalid response for ${countryCode}`)
        continue
      }

      let m3uContent = '#EXTM3U\r\n'
      for (const ch of channels) {
        const streamUrls = ch.sources?.streams
        if (!streamUrls || !streamUrls.length) continue
        for (const streamUrl of streamUrls) {
          const tvgId = ch.nanoid || ''
          const name = ch.name || 'Unknown'
          m3uContent += `#EXTINF:-1 tvg-id="${tvgId}" group-title="Famelack - ${countryCode.toUpperCase()}",${name}\r\n${streamUrl}\r\n`
        }
      }

      await storage.save(path.join('generated', filename), m3uContent)
      logger.info(`  Saved streams/generated/${filename}`)
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || String(err)
      logger.error(`  Failed to fetch famelack ${countryCode}: ${msg.substring(0, 80)}`)
    }
  }
}

async function main() {
  const logger = new Logger()
  const storage = new Storage(STREAMS_DIR)

  await syncIptvOrg(logger, storage)
  await syncExternalPlaylists(logger, storage)
  await syncFamelack(logger, storage)

  logger.info('All streams synced successfully.')
}

main().then(() => {
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
