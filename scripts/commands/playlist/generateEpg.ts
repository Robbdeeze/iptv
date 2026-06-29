import { Logger } from '@freearhey/core'
import { Storage } from '@freearhey/storage-js'
import { ROOT_DIR } from '../../constants'
import axios from 'axios'
import * as zlib from 'zlib'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { program } from 'commander'

const logger = new Logger({ level: 'info' })
const storage = new Storage(ROOT_DIR)

program
  .argument('[m3u-path]', 'Path to M3U playlist', 'Robbdeeze_UltimateTV.m3u')
  .option('--channels-xml [path]', 'Path for generated channels.xml (default: channels.xml)')
  .option('--process-guide <path>', 'Process an already-built guide.xml for matching channels')
  .option('--output-name <name>', 'Output EPG filename prefix', 'Robbdeeze_UltimateTV_Epg')
  .parse()

const options = program.opts()
const m3uPath = program.args[0] || 'Robbdeeze_UltimateTV.m3u'

async function extractTvgIds(m3uRelativePath: string): Promise<Map<string, Set<string>>> {
  const content = fs.readFileSync(path.resolve(ROOT_DIR, m3uRelativePath), 'utf8')
  const baseToFull = new Map<string, Set<string>>()
  const regex = /tvg-id="([^"]*)"/gi
  let match
  while ((match = regex.exec(content)) !== null) {
    const id = match[1].trim()
    if (!id) continue
    const base = id.split('@')[0]
    if (!baseToFull.has(base)) baseToFull.set(base, new Set())
    baseToFull.get(base)!.add(id)
  }
  return baseToFull
}

async function generateChannelsXml(m3uRelativePath: string, outputPath: string) {
  logger.info(`Reading ${m3uRelativePath} ...`)
  const baseToFull = await extractTvgIds(m3uRelativePath)
  const uniqueBaseIds = new Set(baseToFull.keys())
  logger.info(`Found ${baseToFull.size} unique base channel IDs with ${[...baseToFull.values()].reduce((s, v) => s + v.size, 0)} total tvg-id variants`)

  logger.info('Downloading guides.json from iptv-org ...')
  const response = await axios.get('https://iptv-org.github.io/api/guides.json', {
    timeout: 30000,
    responseType: 'json'
  })
  const guides = response.data as any[]

  const guidesByChannel = new Map<string, any[]>()
  for (const g of guides) {
    if (g.channel) {
      if (!guidesByChannel.has(g.channel)) guidesByChannel.set(g.channel, [])
      guidesByChannel.get(g.channel)!.push(g)
    }
  }

  let matched = 0
  const channelsXml: string[] = []
  const siteCounts = new Map<string, number>()

  for (const [baseId, fullIds] of baseToFull) {
    const entries = guidesByChannel.get(baseId)
    if (!entries || entries.length === 0) continue
    matched++

    const feeds = [...fullIds].map(id => id.includes('@') ? id.split('@')[1] : 'SD')
    const feedSet = new Set(feeds)

    const preferFeed = feeds[0]
    let best = entries.find(e => e.feed === preferFeed && e.lang === 'en')
    if (!best) best = entries.find(e => e.feed === preferFeed)
    if (!best) best = entries.find(e => e.lang === 'en')
    if (!best) best = entries[0]

    if (best) {
      channelsXml.push(`  <channel site="${best.site}" site_id="${best.site_id}" lang="${best.lang}" xmltv_id="${baseId}${preferFeed ? '@' + preferFeed : ''}">${best.site_name || baseId}</channel>`)
      const key = `${best.site}|${best.lang}`
      siteCounts.set(key, (siteCounts.get(key) || 0) + 1)
    }
  }

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n' + channelsXml.join('\n') + '\n</channels>\n'
  await storage.save(outputPath, xml)

  logger.info(`Generated ${outputPath} with ${matched}/${baseToFull.size} matched channels (${(matched / baseToFull.size * 100).toFixed(1)}%)`)
  logger.info(`Channels span ${new Set([...siteCounts.keys()].map(k => k.split('|')[0])).size} unique sites`)
  logger.info(`\nSite distribution:`)
  const siteGroups = new Map<string, number>()
  for (const [key, count] of siteCounts) {
    const [site] = key.split('|')
    siteGroups.set(site, (siteGroups.get(site) || 0) + count)
  }
  const sorted = [...siteGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  for (const [site, count] of sorted) {
    logger.info(`  ${site}: ${count} channels`)
  }
}

async function processGuide(guideXmlPath: string, m3uRelativePath: string, outputName: string) {
  logger.info(`Reading ${m3uRelativePath} ...`)
  const baseToFull = await extractTvgIds(m3uRelativePath)
  const allTvgIds = new Set([...baseToFull.values()].flatMap(s => [...s]))

  logger.info(`Reading guide from ${guideXmlPath} ...`)
  const content = fs.readFileSync(path.resolve(ROOT_DIR, guideXmlPath), 'utf8')

  const matchedChannels: string[] = []
  const matchedProgrammes: string[] = []

  const channelRegex = /<channel\s+[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/channel>/gi
  let match
  while ((match = channelRegex.exec(content)) !== null) {
    const tvgId = match[1]
    if (allTvgIds.has(tvgId)) {
      matchedChannels.push(match[0])
    }
  }

  const programmeRegex = /<programme\s+[^>]*channel=["']([^"']+)["'][^>]*>([\s\S]*?)<\/programme>/gi
  while ((match = programmeRegex.exec(content)) !== null) {
    const tvgId = match[1]
    if (allTvgIds.has(tvgId)) {
      matchedProgrammes.push(match[0])
    }
  }

  logger.info(`Extracted ${matchedChannels.length} channels and ${matchedProgrammes.length} programmes matching ${allTvgIds.size} tvg-ids`)

  if (matchedChannels.length === 0) {
    logger.warn('No channels matched! Check tvg-id extraction.')
  }

  let xmltv = '<?xml version="1.0" encoding="UTF-8"?>\n'
  xmltv += '<tv generator-info-name="Robbdeeze UltimateTV EPG Generator">\n'
  for (const channelXml of matchedChannels) {
    xmltv += '  ' + channelXml + '\n'
  }
  for (const programmeXml of matchedProgrammes) {
    xmltv += '  ' + programmeXml + '\n'
  }
  xmltv += '</tv>\n'

  const xmlPath = `${outputName}.xml`
  const gzPath = `${outputName}.xml.gz`
  await storage.save(xmlPath, xmltv)
  logger.info(`Saved ${xmlPath}`)

  const gzipped = zlib.gzipSync(Buffer.from(xmltv, 'utf8'))
  await storage.save(gzPath, gzipped)
  logger.info(`Saved ${gzPath} (${(gzipped.length / 1024 / 1024).toFixed(2)} MB)`)
  logger.info('Done!')
}

async function main() {
  const outputName = options.outputName

  if (options.processGuide) {
    await processGuide(options.processGuide, m3uPath, outputName)
  } else {
    const channelsXmlPath = typeof options.channelsXml === 'string' ? options.channelsXml : 'channels.xml'
    await generateChannelsXml(m3uPath, channelsXmlPath)
  }
}

main().then(() => {
  process.exit(0)
}).catch(err => {
  console.error(err)
  process.exit(1)
})
