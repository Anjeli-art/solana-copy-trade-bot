/**
 * Commitment helpers.
 *
 * We use `processed` for INBOUND WebSocket signals (logs/accountSubscribe)
 * because the latency win is significant and account price events are
 * idempotent.
 *
 * Transaction reads are different: getTransaction/getParsedTransaction require
 * at least `confirmed` in web3/RPC, so forcing `processed` there throws at
 * runtime. Keep tx reads confirmed and let the WS not-ready path defer to
 * polling if the tx is not indexed yet.
 */

export const WS_SIGNAL_COMMITMENT = "processed";
export const TRANSACTION_READ_COMMITMENT = "confirmed" as const;
