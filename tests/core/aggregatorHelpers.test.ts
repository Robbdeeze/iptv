jest.mock('../../scripts/models', () => ({
  Stream: class MockStream {
    title: string
    url: string
    groupTitle: string
    tvgId?: string
    tvgLogo?: string
    constructor(opts: any) {
      Object.assign(this, opts)
    }
    getTvgId() { return this.tvgId || this.title }
    getTvgLogo() { return this.tvgLogo || '' }
  }
}))

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn()
  }
}))

import { extractTimeFromText, isWithin24hrsPT, createStream } from '../../scripts/core/aggregatorHelpers'

describe('extractTimeFromText', () => {
  it('extracts standard time format', () => {
    expect(extractTimeFromText('Game starts at 8:00 PM ET')).toBe('8:00 PM')
  })

  it('extracts AM time', () => {
    expect(extractTimeFromText('Match at 10:30 AM')).toBe('10:30 AM')
  })

  it('extracts 24-hour without am/pm', () => {
    expect(extractTimeFromText('Event at 14:30')).toBe('14:30')
  })

  it('returns null for text without time', () => {
    expect(extractTimeFromText('No time here')).toBeNull()
  })
})

describe('isWithin24hrsPT', () => {
  it('returns true for recent timestamp', () => {
    expect(isWithin24hrsPT(Date.now() - 60 * 60 * 1000)).toBe(true)
  })

  it('returns true for future timestamp within 24h', () => {
    expect(isWithin24hrsPT(Date.now() + 12 * 60 * 60 * 1000)).toBe(true)
  })

  it('returns false for past timestamp >24h ago', () => {
    expect(isWithin24hrsPT(Date.now() - 48 * 60 * 60 * 1000)).toBe(false)
  })

  it('returns false for future timestamp >24h ahead', () => {
    expect(isWithin24hrsPT(Date.now() + 48 * 60 * 60 * 1000)).toBe(false)
  })

  it('handles boundary at exactly -24h', () => {
    expect(isWithin24hrsPT(Date.now() - 24 * 60 * 60 * 1000)).toBe(true)
  })

  it('handles boundary at exactly +24h', () => {
    expect(isWithin24hrsPT(Date.now() + 24 * 60 * 60 * 1000)).toBe(true)
  })
})

describe('createStream', () => {
  it('creates a Stream with title, url, group', () => {
    const stream = createStream('Test Channel', 'https://example.com/stream.m3u8', '! Sports - Test')
    expect(stream.title).toBe('Test Channel')
    expect(stream.url).toBe('https://example.com/stream.m3u8')
    expect(stream.groupTitle).toBe('! Sports - Test')
  })

  it('sets tvgId when provided', () => {
    const stream = createStream('Test', 'https://example.com/stream.m3u8', 'Group', 'tvg-123')
    expect(stream.getTvgId()).toBe('tvg-123')
  })

  it('defaults tvgId to title when not provided', () => {
    const stream = createStream('Test', 'https://example.com/stream.m3u8', 'Group')
    expect(stream.getTvgId()).toBe('Test')
  })

  it('preserves groupTitle', () => {
    const stream = createStream('ESPN', 'http://example.com/espn.m3u8', 'Sports - Live / PPV / Events')
    expect(stream.groupTitle).toBe('Sports - Live / PPV / Events')
  })
})
