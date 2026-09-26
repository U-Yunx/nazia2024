/**
 * CandleChart — a lightweight candlestick chart for historical bars (backtest
 * results, saved strategies). Static series: caller owns the data. Uses the
 * same lightweight-charts setup as the live chart so visuals stay consistent.
 */
import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
} from 'lightweight-charts'
import type { Bar } from '../lib/types'

const UP = '#34d399'
const DOWN = '#fb7185'

function toCandle(b: Bar): CandlestickData {
  // Bars are ISO strings; day bars are date-only. lightweight-charts accepts
  // YYYY-MM-DD or a unix timestamp. Use the date part for day bars and unix
  // seconds otherwise (same convention as the live chart).
  const t = /^\d{4}-\d{2}-\d{2}$/.test(b.time) ? b.time : Math.floor(Date.parse(b.time) / 1000)
  return { time: t as Time, open: b.open, high: b.high, low: b.low, close: b.close }
}

/** Sortable millisecond time for any lightweight-charts Time value. */
function timeToMs(t: Time): number {
  if (typeof t === 'number') return t * 1000
  if (typeof t === 'string') return Date.parse(t)
  // BusinessDay object (e.g. { year, month, day }).
  return Date.UTC(t.year, t.month - 1, t.day)
}

/**
 * lightweight-charts requires strictly ascending, unique times. Upstream
 * providers occasionally return bars newest-first or with duplicate stamps, so
 * normalize before setData — sort asc, then drop consecutive duplicates.
 */
function toSortedCandles(bars: Bar[]): CandlestickData[] {
  return bars
    .map(toCandle)
    .sort((a, b) => timeToMs(a.time) - timeToMs(b.time))
    .filter((c, i, arr) => i === 0 || timeToMs(c.time) !== timeToMs(arr[i - 1].time))
}

export function CandleChart({ bars, height = 360 }: { bars: Bar[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  // Identity of the series currently fitted: fit the visible range when a new
  // series loads (mount / pair or interval change) but NOT on every live tick —
  // otherwise a ticking last bar keeps zooming the chart back out.
  const fittedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(148,163,184,0.08)' },
        horzLines: { color: 'rgba(148,163,184,0.08)' },
      },
      rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
      timeScale: { borderColor: 'rgba(148,163,184,0.2)' },
      crosshair: {
        vertLine: { color: '#22d3ee', labelBackgroundColor: '#0e7490' },
        horzLine: { color: '#22d3ee', labelBackgroundColor: '#0e7490' },
      },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    })
    chartRef.current = chart
    seriesRef.current = series
    const el = containerRef.current
    const ro = new ResizeObserver(() => {
      if (el && el.isConnected) chart.applyOptions({ width: el.clientWidth })
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!seriesRef.current || bars.length === 0) return
    seriesRef.current.setData(toSortedCandles(bars))
    const first = bars[0].time
    if (fittedRef.current !== first) {
      fittedRef.current = first
      chartRef.current?.timeScale().fitContent()
    }
  }, [bars])

  return (
    <div
      ref={containerRef}
      style={{ height }}
      className="w-full rounded-lg border border-border/60 bg-secondary/10"
      role="img"
      aria-label="Candlestick chart"
    />
  )
}