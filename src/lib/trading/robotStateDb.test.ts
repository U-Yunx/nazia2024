import { describe, expect, it } from 'vitest'
import { isSupabaseConfigured } from '../supabase'
import { clearRobotState, loadRobotState, saveRobotState } from './robotStateDb'

/**
 * With no Supabase env vars configured (CI and fresh previews) the client is the
 * offline no-op stub, so every durable robot-state call must resolve safely and
 * report "nothing saved" — the Trading page then falls back to its localStorage
 * copy instead of crashing on load.
 */
describe('robotStateDb (offline)', () => {
  it('runs against the offline client', () => {
    expect(isSupabaseConfigured).toBe(false)
  })

  it('loads nothing when Supabase is not configured', async () => {
    expect(await loadRobotState('user-1', 1)).toBeNull()
  })

  it('saves and clears without throwing', async () => {
    await expect(
      saveRobotState('user-1', 1, { running: true, activity: [{ t: 1, m: 'Started.' }] }),
    ).resolves.toBeUndefined()
    await expect(clearRobotState('user-1', 1)).resolves.toBeUndefined()
  })

  it('is a no-op without a user id (anonymous visitors stay local-only)', async () => {
    expect(await loadRobotState('', 1)).toBeNull()
    await expect(saveRobotState('', 1, { running: true })).resolves.toBeUndefined()
    await expect(clearRobotState('', 1)).resolves.toBeUndefined()
  })

  it('accepts every field of a full state patch', async () => {
    await expect(
      saveRobotState('user-1', 2, {
        running: false,
        run_end_at: null,
        run_start_at: 1_700_000_000_000,
        session_start_equity: 10_000,
        last_run_at: 1_700_000_100_000,
        activity: [],
      }),
    ).resolves.toBeUndefined()
  })
})
