import { ROOT_DIR, STREAMS_DIR } from '../../constants'
import { Storage } from '@freearhey/storage-js'
import { PlaylistParser } from '../../core'
import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import { eachLimit } from 'async'
import fs from 'node:fs'
import path from 'node:path'
import axios from 'axios'

const CHECK_TIMEOUT = 8000
const CHECK_CONCURRENCY = 100
const FATAL_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN', 'HTTP_000'])

function parseArg(key: string, def?: string): string | undefined {
  for (const a of process.argv) {
    if (a.startsWith(`--${key}=`)) return a.split('=')[1]
    if (a.startsWith(`--${key}`)) return 'true'
  }
  return def
}

const scope = parseArg('scope', 'ultimate')!
const limit = parseInt(parseArg('limit', '1000') || '1000', 10)
const logger = new Logger()

async function checkStream(url: string): Promise<{ ok: boolean; code: string }> {
  try {
    const headRes = await axios.head(url, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    if (headRes.status === 200 || headRes.status === 206) return { ok: true, code: 'OK' }

    const rangeRes = await axios.get(url, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT),
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-1023' }
    })
    if (rangeRes.status === 200 || rangeRes.status === 206) return { ok: true, code: 'OK' }

    return { ok: false, code: `HTTP_${rangeRes.status}` }
  } catch (err: unknown) {
    const error = err as { name?: string; code?: string; response?: { status: number }; cause?: { code?: string; name?: string } }
    let code = 'UNREACHABLE'
    if (error.name === 'CanceledError') code = 'TIMEOUT'
    else if (error.name === 'AxiosError' && error.response) code = `HTTP_${error.response.status}`
    else if (error.cause) code = error.cause.code || error.cause.name || code
    return { ok: false, code }
  }
}

async function main() {
  const streams: Stream[] = []
  const storage = new Storage(ROOT_DIR)
  const parser = new PlaylistParser({ storage })

  if (scope === 'ultimate') {
    if (!fs.existsSync(path.join(ROOT_DIR, 'Robbdeeze_UltimateTV.m3u'))) {
      logger.error('Robbdeeze_UltimateTV.m3u not found')
      process.exit(1)
    }
    const parsed = await parser.parse(['Robbdeeze_UltimateTV.m3u'])
    streams.push(...parsed.all())
    logger.info(`Loaded ${streams.length} streams from Robbdeeze_UltimateTV.m3u`)
  } else if (scope === 'all') {
    const files = await storage.list(`${STREAMS_DIR}/**/*.m3u`)
    const parsed = await parser.parse(files)
    streams.push(...parsed.all())
    logger.info(`Loaded ${streams.length} streams from ${files.length} files`)
  } else {
    const parsed = await parser.parse([scope])
    streams.push(...parsed.all())
    logger.info(`Loaded ${streams.length} streams from ${scope}`)
  }

  if (streams.length === 0) {
    logger.warn('No streams to check')
    console.log('No streams found')
    return
  }

  const sample = limit > 0 && limit < streams.length
    ? streams.sort(() => Math.random() - 0.5).slice(0, limit)
    : streams

  logger.info(`Checking ${sample.length} streams (${sample.length < streams.length ? `random sample of ${streams.length}` : 'all'})`)

  const results: { ok: boolean; code: string; url: string; title: string; group: string }[] = []
  let checked = 0
  let ok = 0
  let dead = 0

  await eachLimit(sample, CHECK_CONCURRENCY, async (stream: Stream) => {
    const result = await checkStream(stream.url)
    results.push({
      ...result,
      url: stream.url,
      title: stream.title || '',
      group: stream.groupTitle || '',
    })
    if (result.ok) ok++
    else if (FATAL_CODES.has(result.code)) dead++
    checked++
    if (checked % 200 === 0 || checked === sample.length) {
      logger.info(`  ${checked}/${sample.length} — ${ok} ok, ${dead} dead`)
    }
  })

  const working = results.filter(r => r.ok)
  const fatal = results.filter(r => FATAL_CODES.has(r.code))
  const nonFatal = results.filter(r => !r.ok && !FATAL_CODES.has(r.code))

  const codeCounts = new Map<string, number>()
  for (const r of results) codeCounts.set(r.code, (codeCounts.get(r.code) || 0) + 1)

  const groupStats = new Map<string, { total: number; ok: number; dead: number }>()
  for (const r of results) {
    const g = r.group || '(none)'
    if (!groupStats.has(g)) groupStats.set(g, { total: 0, ok: 0, dead: 0 })
    const s = groupStats.get(g)!
    s.total++
    if (r.ok) s.ok++
    else if (FATAL_CODES.has(r.code)) s.dead++
  }

  const lines: string[] = []
  lines.push('# Stream Check Report')
  lines.push(`Scope: ${scope}`)
  lines.push(`Date: ${new Date().toISOString()}`)
  lines.push(`Sample: ${sample.length} of ${streams.length}`)
  lines.push('')
  lines.push(`Total:     ${sample.length}`)
  lines.push(`Working:   ${working.length} (${(working.length / sample.length * 100).toFixed(1)}%)`)
  lines.push(`Dead:      ${fatal.length} (${(fatal.length / sample.length * 100).toFixed(1)}%)`)
  lines.push(`Non-fatal: ${nonFatal.length} (${(nonFatal.length / sample.length * 100).toFixed(1)}%)`)
  lines.push('')
  lines.push('## Status Codes')
  const sorted = [...codeCounts.entries()].sort((a, b) => b[1] - a[1])
  for (const [code, count] of sorted) {
    lines.push(`  ${code}: ${count}`)
  }
  lines.push('')
  lines.push('## By Group')
  const sortedGroups = [...groupStats.entries()].sort((a, b) => b[1].total - a[1].total)
  for (const [group, stats] of sortedGroups) {
    const pct = stats.total > 0 ? (stats.ok / stats.total * 100).toFixed(0) : '0'
    lines.push(`  ${group}: ${stats.total} total, ${stats.ok} ok (${pct}%), ${stats.dead} dead`)
  }
  lines.push('')

  if (fatal.length > 0) {
    lines.push('## Dead Streams (fatal)')
    for (const d of fatal.slice(0, 100)) {
      const g = d.group.substring(0, 30).padEnd(32)
      const t = d.title.substring(0, 50).padEnd(52)
      const u = d.url.substring(0, 80)
      lines.push(`  [${d.code}] ${g}${t}${u}`)
    }
    if (fatal.length > 100) lines.push(`  ... and ${fatal.length - 100} more`)
    lines.push('')
  }

  fs.writeFileSync('/tmp/stream-check-report.txt', lines.join('\n'))
  console.log(lines.join('\n'))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
