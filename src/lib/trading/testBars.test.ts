import { describe, expect, it } from 'vitest'
import { burstBars, rangeBars, trendingWavesBars, uptrendBars } from './testBars'

describe('testBars fixtures', () => {
  it('builds the requested number of bars', () => {
    expect(uptrendBars(90)).toHaveLength(90)
    expect(rangeBars(90)).toHaveLength(90)
    expect(burstBars(80, 6)).toHaveLength(86)
    expect(trendingWavesBars(90)).toHaveLength(90)
  })

  it('is deterministic across calls', () => {
    expect(rangeBars(30).map((b) => b.close)).toEqual(rangeBars(30).map((b) => b.close))
    expect(trendingWavesBars(30).map((b) => b.close)).toEqual(trendingWavesBars(30).map((b) => b.close))
  })
})