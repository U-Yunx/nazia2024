/**
 * Broker / MetaApi error normalization — client view.
 *
 * This is a thin re-export of the canonical pure module the broker-mt Edge
 * Function imports (supabase/functions/broker-mt/brokerErrors.ts), so the
 * Brokers page and the bridge always agree on what a "broker rejected the
 * login" message looks like. It has no runtime dependencies and is exercised
 * directly by the Vitest suite.
 */
export * from '../../supabase/functions/broker-mt/brokerErrors'