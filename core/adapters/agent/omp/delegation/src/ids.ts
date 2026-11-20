import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_RE = /^dlg_[0-9A-HJKMNP-TV-Z]{26}$/;

/** `dlg_` + 10 time characters (sortable) + 16 random characters. */
export function newDelegationId(now: number = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const random = [...randomBytes(16)].map((b) => CROCKFORD[b % 32]).join("");
  return `dlg_${time}${random}`;
}

export function isDelegationId(s: unknown): s is string {
  return typeof s === "string" && ID_RE.test(s);
}
