import { PlaylistParser, CliTable } from '../../core'
import { ROOT_DIR, STREAMS_DIR } from '../../constants'
import { Logger, Collection } from '@freearhey/core'
import { program, OptionValues } from 'commander'
import { Storage } from '@freearhey/storage-js'
import { Playlist, Stream } from '../../models'
import { truncate } from '../../utils'
import axios, { AxiosInstance, AxiosRequestConfig, AxiosProxyConfig } from 'axios'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { ProxyParser } from '../../core/proxyParser'
import { eachLimit } from 'async'
import dns from 'node:dns'
import chalk from 'chalk'

const CHECK_TIMEOUT = 10000

let errors = 0
let warnings = 0
let interval: string | number | NodeJS.Timeout | undefined
let streams: Stream[] = []

const errorStatusCodes = [
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EPROTO',
  'HTTP_404_',
  'HTTP_404_NOT_FOUND',
  'HTTP_404_UNKNOWN_ERROR',
  'HTTP_410_GONE'
]

program
  .argument('[filepath...]', 'Path to file to check')
  .option(
    '-p, --parallel <number>',
    'Batch size of streams to check concurrently',
    (value: string) => parseInt(value),
    50
  )
  .option('-x, --proxy <url>', 'Use the specified proxy')
  .option('--fix', 'Remove all broken links found from files')
  .parse(process.argv)

const options: OptionValues = program.opts()

const logger = new Logger()

function createClient(): AxiosInstance {
  const proxyParser = new ProxyParser()
  let request: AxiosRequestConfig = {}
  if (options.proxy !== undefined) {
    const proxy = proxyParser.parse(options.proxy) as AxiosProxyConfig
    if (
      proxy.protocol &&
      ['socks', 'socks5', 'socks5h', 'socks4', 'socks4a'].includes(String(proxy.protocol))
    ) {
      const socksProxyAgent = new SocksProxyAgent(options.proxy)
      request = { ...request, ...{ httpAgent: socksProxyAgent, httpsAgent: socksProxyAgent } }
    } else {
      request = { ...request, ...{ proxy } }
    }
  }
  return axios.create(request)
}

const client = createClient()

async function isStreamWorking(url: string): Promise<{ ok: boolean; code: string }> {
  try {
    const headRes = await client.head(url, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    if (headRes.status === 200 || headRes.status === 206) return { ok: true, code: 'OK' }

    const rangeRes = await client.get(url, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-1023' }
    })
    if (rangeRes.status === 200 || rangeRes.status === 206) return { ok: true, code: 'OK' }

    return { ok: false, code: `HTTP_${rangeRes.status}` }
  } catch (err: unknown) {
    const error = err as { name?: string; code?: string; response?: { status: number; statusText: string }; cause?: { code?: string; name?: string } }
    let code = 'UNREACHABLE'
    if (error.name === 'CanceledError') {
      code = 'TIMEOUT'
    } else if (error.name === 'AxiosError') {
      if (error.response) {
        const status = error.response.status
        const statusText = error.response.statusText.toUpperCase().replace(/\s+/, '_')
        code = `HTTP_${status}_${statusText}`
      } else {
        code = `AXIOS_${error.code || 'UNKNOWN'}`
      }
    } else if (error.cause) {
      code = error.cause.code || error.cause.name || code
    }
    return { ok: false, code }
  }
}

async function main() {
  if (await isOffline()) {
    logger.error(chalk.red('Internet connection is required for the script to work'))
    return
  }

  logger.info('loading streams...')
  const rootStorage = new Storage(ROOT_DIR)
  const parser = new PlaylistParser({ storage: rootStorage })
  const files = program.args.length
    ? program.args
    : await rootStorage.list(`${STREAMS_DIR}/**/*.m3u`)

  const parsed = await parser.parse(files)
  streams = parsed.all()
  logger.info(`found ${streams.length} streams`)

  drawTable()
  interval = setInterval(() => { drawTable() }, 3000)

  let completed = 0
  let workingCount = 0
  eachLimit(
    streams,
    options.parallel,
    async (stream: Stream) => {
      stream.statusCode = 'CHECKING...'
      const result = await isStreamWorking(stream.url)
      stream.statusCode = result.code
      completed++
      workingCount += result.ok ? 1 : 0

      if (result.code === 'OK') return
      if (errorStatusCodes.includes(result.code) && !stream.label) {
        errors++
      } else {
        warnings++
      }
    },
    async (error) => {
      clearInterval(interval)
      if (error) {
        console.error(error)
        process.exit(1)
      }

      logger.info(`\n${completed} checked, ${workingCount} working, ${errors} errors, ${warnings} warnings`)

      if (options.fix) {
        await removeBrokenLinks()
        drawTable()
        process.exit(0)
      }

      drawTable()
      if (errors > 0) process.exit(1)
      process.exit(0)
    }
  )
}

main()

async function removeBrokenLinks() {
  const rootStorage = new Storage(ROOT_DIR)
  const streamsGrouped = new Collection(streams).groupBy((stream: Stream) => stream.getFilepath())

  for (const filepath of streamsGrouped.keys()) {
    let fileStreams: Collection<Stream> = new Collection(streamsGrouped.get(filepath))
    const before = fileStreams.count()
    fileStreams = fileStreams.filter((stream: Stream) => {
      if (!stream.statusCode) return true
      if (stream.label) return true
      if (!errorStatusCodes.includes(stream.statusCode)) return true
      return false
    })
    const removed = before - fileStreams.count()
    if (removed === 0) continue

    const playlist = new Playlist(fileStreams, { public: false })
    await rootStorage.save(filepath, playlist.toString())
    logger.info(`removed ${removed} broken streams from ${filepath}`)
  }
}

async function isOffline() {
  return new Promise((resolve) => {
    dns.lookup('info.cern.ch', (err) => {
      if (err) resolve(true)
      resolve(false)
    })
  })
}

function drawTable() {
  process.stdout.write('\u001b[3J\u001b[1J')
  console.clear()

  const grouped = new Map<string, Stream[]>()
  streams.forEach((s) => {
    const fp = s.getFilepath() || 'unknown'
    if (!grouped.has(fp)) grouped.set(fp, [])
    grouped.get(fp)!.push(s)
  })

  for (const [filepath, fileStreams] of grouped) {
    const table = new CliTable({
      columns: [
        { name: '', alignment: 'center', minLen: 3, maxLen: 3 },
        { name: 'tvg-id', alignment: 'left', color: 'green', minLen: 25, maxLen: 25 },
        { name: 'url', alignment: 'left', color: 'green', minLen: 100, maxLen: 100 },
        { name: 'label', alignment: 'left', color: 'yellow', minLen: 13, maxLen: 13 },
        { name: 'status', alignment: 'left', minLen: 25, maxLen: 25 }
      ]
    })

    fileStreams.forEach((stream, index) => {
      const tvgId = truncate(stream.getTvgId(), 25)
      const url = truncate(stream.url, 100)
      const color = getColor(stream)
      const label = stream.label || ''
      const status = stream.statusCode || 'PENDING'

      table.append({
        '': index,
        'tvg-id': chalk[color](tvgId),
        url: chalk[color](url),
        label: chalk[color](label),
        status: chalk[color](status)
      })
    })

    process.stdout.write(`\n${chalk.underline(filepath)}\n`)
    process.stdout.write(table.toString())
  }
}

function getColor(stream: Stream): string {
  if (!stream.statusCode) return 'gray'
  if (stream.statusCode === 'CHECKING...') return 'white'
  if (stream.statusCode === 'OK') return 'green'
  if (errorStatusCodes.includes(stream.statusCode) && !stream.label) return 'red'
  return 'yellow'
}
