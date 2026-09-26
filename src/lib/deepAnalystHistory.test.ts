import { describe, expect, it } from 'vitest'
import {
  engineLabel,
  fetchAnalystHistory,
  runToResponse,
  type AnalystRun,
  type HistoryQueryClient,
} from './deepAnalystHistory'

const SAMPLE: AnalystRun = {
  id: 'run-1',
  symbol: 'GBP/USD',
  side: 'short',
  entry_price: 1.27,
  mark: 1.2712,
  engine: 'gemini',
  ai_used: true,
  model: 'gemini-2.5-flash-lite',
  strategy: {
    verdict: 'trail',
    action: 'Protect gains',
    confidence: 72,
    targets: [],
    stop: { price: 1.268, note: '' },
    reasoning: [],
    risks: [],
    timeframe: 'next 4h',
  },
  created_at: '2026-01-05T10:00:00Z',
}

function fakeClient(rows: unknown[] | null, error: { message: string } | null = null): HistoryQueryClient {
  return {
    from: (table) => ({
      select: (columns) => ({
        order: (column, opts) => ({
          limit: async (count) => {
            expect(table).toBe('deep_analyst_runs')
            expect(columns).toBe('*')
            expect(column).toBe('created_at')
            expect(opts?.ascending).toBe(false)
            expect(count).toBe(8)
            return { data: rows, error }
          },
        }),
      }),
    }),
  }
}

describe('deepAnalystHistory', () => {
  it('engineLabel maps known engines and defaults unknown ones', () => {
    expect(engineLabel('gemini')).toBe('Gemini')
    expect(engineLabel('openai')).toBe('OpenAI')
    expect(engineLabel('deterministic')).toBe('Built-in engine')
    expect(engineLabel('anything-else')).toBe('Built-in engine')
  })

  it('fetchAnalystHistory returns [] for a missing client', async () => {
    await expect(fetchAnalystHistory(undefined)).resolves.toEqual([])
    await expect(fetchAnalystHistory(null)).resolves.toEqual([])
  })

  it('fetchAnalystHistory queries the table and maps rows', async () => {
    const runs = await fetchAnalystHistory(
      fakeClient([
        SAMPLE,
        { ...SAMPLE, id: 'run-2', side: 'long', ai_used: false, engine: 'deterministic', model: null },
      ]),
    )
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      id: 'run-1',
      symbol: 'GBP/USD',
      side: 'short',
      engine: 'gemini',
      ai_used: true,
      model: 'gemini-2.5-flash-lite',
    })
    expect(runs[1].side).toBe('long')
    expect(runs[1].ai_used).toBe(false)
    expect(runs[1].model).toBeNull()
  })

  it('fetchAnalystHistory returns [] on query error or empty data', async () => {
    await expect(fetchAnalystHistory(fakeClient(null, { message: 'nope' }))).resolves.toEqual([])
    await expect(fetchAnalystHistory(fakeClient([]))).resolves.toEqual([])
  })

  it('runToResponse rebuilds a renderable response', () => {
    const res = runToResponse(SAMPLE)
    expect(res.ok).toBe(true)
    expect(res.engine).toBe('gemini')
    expect(res.ai_available).toBe(true)
    expect(res.ai_requires_login).toBe(false)
    expect(res.model).toBe('gemini-2.5-flash-lite')
    expect(res.note).toBeUndefined()
    expect(res.strategy).toEqual(SAMPLE.strategy)

    const det = runToResponse({ ...SAMPLE, engine: 'deterministic', ai_used: false, model: null })
    expect(det.engine).toBe('deterministic')
    expect(det.model).toBeUndefined()
    expect(det.note).toContain('built-in')
  })
})
