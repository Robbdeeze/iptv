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

interface UpstreamFile {
  name: string
  download_url: string
  type: string
}

async function main() {
  const logger = new Logger()

  logger.info(`Fetching file list from ${API_URL} ...`)
  const res = await axios.get(API_URL, {
    timeout: 15000,
    headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }
  })

  const files: UpstreamFile[] = res.data
  const m3uFiles = files.filter(f => f.type === 'file' && f.name.endsWith('.m3u'))
  logger.info(`Found ${m3uFiles.length} M3U files upstream`)

  const storage = new Storage(STREAMS_DIR)
  let downloaded = 0
  let skipped = 0

  for (const file of m3uFiles) {
    const name = file.name
    const isCountryFile = /^[a-z]{2}\.m3u$/.test(name)
    const subdir = isCountryFile ? 'countries' : 'sources'

    try {
      const url = `${RAW_BASE}/${name}`
      const dl = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': UA }
      })
      const content = typeof dl.data === 'string' ? dl.data : String(dl.data)

      await storage.save(path.join(subdir, name), content)
      downloaded++
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message || String(err)
      logger.error(`  Failed to download ${name}: ${msg.substring(0, 60)}`)
      skipped++
    }
  }

  logger.info(`Done: ${downloaded} downloaded, ${skipped} skipped`)
}

main().then(() => {
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
