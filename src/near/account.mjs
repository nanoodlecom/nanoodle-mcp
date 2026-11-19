import { NearError } from "./errors.mjs";

// NEAR account ids: 2-64 chars of lowercase alphanumerics, separated by single
// '.', '_' or '-'. 64-character hex implicit accounts match the same pattern.
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function isNearAccountId(id) {
  return typeof id === "string" && ACCOUNT_ID.test(id);
}

export function assertNearAccountId(id) {
  if (!isNearAccountId(id)) {
    const shown = typeof id === "string" && id.length <= 80 ? JSON.stringify(id) : `a ${typeof id}`;
    throw new NearError("BAD_ACCOUNT", `not a valid NEAR account id: ${shown}`);
  }
  return id;
}
