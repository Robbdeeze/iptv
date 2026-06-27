import { Logger } from '@freearhey/core'
import { Stream } from '../../models'
import axios from 'axios'
import { extractM3u8FromEmbed, closeBrowser } from '../../core/aggregatorHelpers'
import { eachLimit } from 'async'

const GROUP_TITLE = '! Sports - Streamed'

interface MatchSource {
  source: string
  id: string
}

interface TeamInfo {
  name: string
  badge?: string
}

interface Match {
  id: string
  title: string
  category: string
  date: number
  popular?: boolean
  teams?: { home?: TeamInfo; away?: TeamInfo }
  sources: MatchSource[]
}

interface StreamOption {
  id: string
  streamNo: number
  language: string
  hd: boolean
  embedUrl: string
  source: string
  viewers: number
}

const EMBED_CONCURRENCY = 5

function isEnglishOrNoLanguage(lang: string): boolean {
  const lower = lang.toLowerCase()
  return (
    !lower ||
    lower === 'english' ||
    lower.startsWith('english') ||
    lower.includes('eng')
  )
}

export async function scrapeStreamed(
  logger: Logger
): Promise<{ groupTitle: string; streams: Stream[] }[]> {
  const result: { groupTitle: string; streams: Stream[] }[] = []
  const seenUrls = new Set<string>()
  const streams: Stream[] = []

  const domain = 'https://streamed.pk'

  try {
    // Step 1: Get all sports categories
    logger.info('Fetching sports categories...')
    const sportsResp = await axios.get(`${domain}/api/sports`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const sports: { id: string; name: string }[] = sportsResp.data
    logger.info(`Found ${sports.length} sport categories`)

    // Step 2: Fetch matches for each sport
    const allMatches: Match[] = []
    for (const sport of sports) {
      try {
        const matchesResp = await axios.get(`${domain}/api/matches/${sport.id}`, {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        })
        const matches: Match[] = matchesResp.data
        if (matches.length > 0) {
          allMatches.push(...matches)
          logger.info(`  ${sport.name}: ${matches.length} matches`)
        }
      } catch {
        // Some sports might not have matches
      }
    }

    logger.info(`Total matches: ${allMatches.length}`)

    if (allMatches.length === 0) {
      return result
    }

    // Step 3: Collect all stream options to resolve
    interface EmbedJob {
      embedUrl: string
      title: string
      label: string
    }
    const embedJobs: EmbedJob[] = []

    let matchCount = 0
    for (const match of allMatches) {
      matchCount++
      const title = match.title
      for (const source of match.sources) {
        try {
          const streamResp = await axios.get(
            `${domain}/api/stream/${source.source}/${source.id}`,
            { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
          )
          const options: StreamOption[] = streamResp.data
          if (!options || options.length === 0) continue

          const englishHD = options.filter((o) => isEnglishOrNoLanguage(o.language) && o.hd)
          const english = options.filter((o) => isEnglishOrNoLanguage(o.language))
          const chosen = englishHD.length > 0 ? englishHD[0] : english.length > 0 ? english[0] : options[0]

          embedJobs.push({
            embedUrl: chosen.embedUrl,
            title,
            label: `${chosen.language}${chosen.hd ? ' HD' : ''}`
          })
        } catch {
          // Source might not be available
        }
      }
    }

    logger.info(`Resolving ${embedJobs.length} stream embeds (concurrency: ${EMBED_CONCURRENCY})...`)

    let completed = 0
    await eachLimit(embedJobs, EMBED_CONCURRENCY, async (job: EmbedJob) => {
      completed++
      logger.info(`  [${completed}/${embedJobs.length}] ${job.title} - ${job.label}`)
      const m3u8Url = await extractM3u8FromEmbed(job.embedUrl, logger)
      if (m3u8Url && !seenUrls.has(m3u8Url)) {
        seenUrls.add(m3u8Url)
        const stream = new Stream({
          channel: null,
          feed: null,
          title: job.title,
          url: m3u8Url,
          quality: null,
          referrer: null,
          user_agent: null,
          label: null
        })
        stream.tvgId = job.title
        stream.tvgLogo = ''
        stream.groupTitle = GROUP_TITLE
        streams.push(stream)
        logger.info(`    -> m3u8 found: ${m3u8Url.substring(0, 80)}...`)
      }
    })

    logger.info(
      `Total Streamed streams: ${streams.length}`
    )
  } catch (err: any) {
    logger.error(`Streamed scraper failed: ${err.message || err}`)
  } finally {
    await closeBrowser()
  }

  if (streams.length > 0) {
    result.push({ groupTitle: GROUP_TITLE, streams })
  }

  return result
}
