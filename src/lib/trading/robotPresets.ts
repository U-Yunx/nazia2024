/**
 * One-click robot configuration presets — Best / Common / Manual.
 *
 * Each preset is a full `RobotPrefs` profile so a single click sets EVERY
 * robot configuration field (trading style, strategy mode, pairs, trade
 * mode & concurrency, run limits, profit pull-back) at once, instead of the
 * user having to touch a dozen inputs on the Configuration page.
 *
 *   - 'best'    — the tuned, risk-aware profile: the robot evaluates all four
 *                 strategies per pair and applies the best one, auto-picks the
 *                 5 strongest pairs, trades one position per pair at a time,
 *                 lets stops/targets size from market volatility (ATR) and
 *                 banks winners with the 25% profit-pull-back lock.
 *   - 'common'  — the everyday default robot: the app's out-of-the-box values
 *                 on the classic 7 FX majors (spread across the watchlist so
 *                 it is immediately usable, not stuck on one pair).
 *   - 'manual'  — a no-clobber option: nothing is overwritten. Selecting it
 *                 simply switches the robot to manual strategy picking; every
 *                 field the user already set stays exactly as it is.
 *
 * The selected mode is persisted locally so the button group reflects what is
 * running between visits.
 */
import type { RobotPrefs } from '../types'
import { FX_PAIRS } from '../watchlist'

export type RobotPresetKey = 'best' | 'common' | 'manual'

export interface RobotPreset {
  key: RobotPresetKey
  label: string
  description: string
  /** Full prefs to apply, or null for 'manual' (keep the user's own settings). */
  prefs: RobotPrefs | null
}

/** The tuned, risk-aware profile — the recommended one. */
const BEST: RobotPrefs = {
  method: 'scalping',
  strategyMode: 'auto',
  manualStrategy: 'MA',
  durationMinutes: null,
  pairs: [],
  autoPickPairs: true,
  pairCount: 5,
  perTradeTakeProfitPips: 0,
  perTradeStopLossPips: 0,
  overallMaxProfitUsd: 0,
  overallMaxLossUsd: 0,
  tradeMode: 'sequential',
  maxPerPair: 1,
  maxOpenTrades: 0,
  profitPullbackPct: 25,
  lot: 1,
}

/** Everyday defaults, pre-wired to the classic 7 FX majors. */
const COMMON: RobotPrefs = {
  method: 'scalping',
  strategyMode: 'auto',
  manualStrategy: 'MA',
  durationMinutes: null,
  pairs: FX_PAIRS.slice(0, 7).map((p) => p.symbol),
  autoPickPairs: false,
  pairCount: 5,
  perTradeTakeProfitPips: 0,
  perTradeStopLossPips: 0,
  overallMaxProfitUsd: 0,
  overallMaxLossUsd: 0,
  tradeMode: 'sequential',
  maxPerPair: 1,
  maxOpenTrades: 0,
  profitPullbackPct: 25,
  lot: 1,
}

export const ROBOT_PRESETS: RobotPreset[] = [
  {
    key: 'best',
    label: 'Best setting',
    description:
      'Auto best-method on every pair, top 5 strongest pairs auto-picked, one position per pair, ATR-sized stops and a 25% profit-pull-back lock.',
    prefs: BEST,
  },
  {
    key: 'common',
    label: 'Common setting',
    description:
      'The everyday default robot — auto strategy evaluation on the classic 7 FX majors, one position per pair, no extra caps.',
    prefs: COMMON,
  },
  {
    key: 'manual',
    label: 'Manual setting',
    description:
      'Keeps exactly what you configured. Switches the strategy to your own choice and leaves every other field untouched.',
    prefs: null,
  },
]

export function presetByKey(key: RobotPresetKey): RobotPreset {
  return ROBOT_PRESETS.find((p) => p.key === key) ?? ROBOT_PRESETS[2]
}

const MODE_KEY = 'ana24.robot-settings-preset'

export function loadPresetMode(): RobotPresetKey {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    return raw === 'best' || raw === 'common' ? raw : 'manual'
  } catch {
    return 'manual'
  }
}

export function savePresetMode(key: RobotPresetKey): void {
  try {
    localStorage.setItem(MODE_KEY, key)
  } catch {
    /* noop */
  }
}