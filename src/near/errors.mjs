/**
 * One error class for the NEAR payment rail. `code` is a stable string that
 * callers branch on; `message` is for humans. Messages never contain key
 * material or the raw text of a secret the caller handed in.
 *
 * Codes used across the rail:
 *   BAD_AMOUNT, BAD_RATE, BAD_BASE58, BAD_KEY, KEY_ACCOUNT_MISMATCH, BAD_ACCOUNT,
 *   RPC_HTTP, RPC_TIMEOUT, RPC_BAD_RESPONSE, QUERY_ERROR,
 *   RPC cause names passed through verbatim (UNKNOWN_TRANSACTION, TIMEOUT_ERROR,
 *   INVALID_TRANSACTION, UNKNOWN_BLOCK, UNKNOWN_ACCOUNT, PARSE_ERROR, ...),
 *   TX_NOT_FOUND, TX_NOT_FINAL, TX_FAILED, NOT_A_SINGLE_TRANSFER, WRONG_RECEIVER,
 *   TX_MISMATCH, RPC_UNAVAILABLE, STATE_UNREADABLE, STATE_MISMATCH,
 *   RATE_UNAVAILABLE, NO_UNIQUE_AMOUNT, DUPLICATE_ID, NOT_FOUND.
 */
export class NearError extends Error {
  constructor(code, message, { cause, data } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NearError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}
