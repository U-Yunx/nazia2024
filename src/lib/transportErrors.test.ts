import { describe, expect, it } from 'vitest'
import {
  TRANSPORT_MESSAGES,
  classifyTransportError,
  edgeErrorMessage,
  humanizeTransportError,
} from './transportErrors'

/**
 * The bug these guard: a stalled edge-function request rendered the runtime's
 * raw string literally — `Error: ReadTimeout: ` — in the app.
 */
describe('classifyTransportError', () => {
  it('recognises the raw runtime signatures that used to reach the UI', () => {
    expect(classifyTransportError('ReadTimeout: ')).toBe('timeout')
    expect(classifyTransportError('Error: ReadTimeout: ')).toBe('timeout')
    expect(classifyTransportError('HeadersTimeout: ')).toBe('timeout')
    expect(classifyTransportError('BodyTimeout: ')).toBe('timeout')
    expect(classifyTransportError('ConnectTimeout: ')).toBe('timeout')
    expect(classifyTransportError('IDLE_TIMEOUT')).toBe('timeout')
    expect(classifyTransportError('ETIMEDOUT')).toBe('timeout')
    expect(classifyTransportError('error sending request: operation timed out')).toBe('timeout')
    expect(classifyTransportError('The operation was aborted due to timeout')).toBe('timeout')
  })

  it('reads Error and DOMException shapes, including nested causes', () => {
    expect(classifyTransportError(new Error('ReadTimeout: '))).toBe('timeout')
    expect(classifyTransportError({ name: 'TimeoutError', message: '' })).toBe('timeout')
    expect(classifyTransportError({ name: 'AbortError', message: 'This operation was aborted' })).toBe('timeout')
    expect(classifyTransportError({ cause: new Error('socket hang up') })).toBe('unreachable')
    expect(classifyTransportError({ message: 'fetch failed' })).toBe('unreachable')
  })

  it('maps gateway and dropped-connection failures to their own buckets', () => {
    expect(classifyTransportError('504 Gateway Timeout')).toBe('timeout')
    expect(classifyTransportError('502 Bad Gateway')).toBe('bad_gateway')
    expect(classifyTransportError('503 Service Unavailable')).toBe('bad_gateway')
    expect(classifyTransportError('Failed to fetch')).toBe('unreachable')
    expect(classifyTransportError('TypeError: fetch failed')).toBe('unreachable')
    expect(classifyTransportError('Error: read ECONNRESET')).toBe('unreachable')
    expect(classifyTransportError('Error: terminated')).toBe('unreachable')
    expect(classifyTransportError('socket hang up')).toBe('unreachable')
  })

  it('never rewrites a business error — those keep their own wording', () => {
    const brokerRejection =
      'ValidationError: Account with such credentials does not exist, credentials are invalid or the account has been blocked'
    expect(classifyTransportError(brokerRejection)).toBeNull()
    expect(classifyTransportError('Invalid API token')).toBeNull()
    expect(classifyTransportError('Market data is unavailable right now.')).toBeNull()
    expect(classifyTransportError('The broker rejected this trade — not enough free margin.')).toBeNull()
    expect(classifyTransportError('internal')).toBeNull()
    // Library copy is not a transport signature: callers replace it with their
    // own contextual fallback rather than generic transport wording.
    expect(classifyTransportError('Failed to send a request to the Edge Function')).toBeNull()
  })

  it('handles empty and non-error input without throwing', () => {
    expect(classifyTransportError(null)).toBeNull()
    expect(classifyTransportError(undefined)).toBeNull()
    expect(classifyTransportError('')).toBeNull()
    expect(classifyTransportError({})).toBeNull()
    expect(humanizeTransportError(0)).toBeNull()
  })
})

describe('humanizeTransportError', () => {
  it('returns user-safe copy for transport failures', () => {
    expect(humanizeTransportError('ReadTimeout: ')).toBe(TRANSPORT_MESSAGES.timeout)
    expect(humanizeTransportError({ message: '502 Bad Gateway' })).toBe(TRANSPORT_MESSAGES.bad_gateway)
    expect(humanizeTransportError('fetch failed')).toBe(TRANSPORT_MESSAGES.unreachable)
  })

  it('returns null for business errors so callers keep the real reason', () => {
    expect(humanizeTransportError('Invalid API token')).toBeNull()
  })

  it('never leaks the raw runtime text it was given', () => {
    const copy = humanizeTransportError('ReadTimeout: ')
    expect(copy).not.toBeNull()
    expect(copy).not.toMatch(/readtimeout/i)
    expect(copy).not.toMatch(/^\s*error:/i)
  })
})

describe('edgeErrorMessage', () => {
  it('prefers a transport explanation over the caller fallback', () => {
    expect(edgeErrorMessage(new Error('ReadTimeout: '), 'Could not update the API key.')).toBe(
      TRANSPORT_MESSAGES.timeout,
    )
  })

  it('falls back to the contextual copy for anything else — never raw error text', () => {
    expect(edgeErrorMessage({ message: 'Failed to send a request to the Edge Function' }, 'Could not disconnect the provider.')).toBe(
      'Could not disconnect the provider.',
    )
    expect(edgeErrorMessage({ message: 'Edge Function returned a non-2xx status code' }, 'Could not reconfigure the API settings.')).toBe(
      'Could not reconfigure the API settings.',
    )
    expect(edgeErrorMessage(null, 'Could not enable free market data.')).toBe(
      'Could not enable free market data.',
    )
  })

  it('always returns a non-empty, human-readable string', () => {
    const cases: unknown[] = ['ReadTimeout: ', new Error('boom'), null, undefined, {}, 42]
    for (const value of cases) {
      const message = edgeErrorMessage(value, 'Something went wrong. Please try again.')
      expect(typeof message).toBe('string')
      expect(message.length).toBeGreaterThan(0)
    }
  })
})
