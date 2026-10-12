import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CollabRole } from "@vizli/shared";

/**
 * Who may change a project. The edit token is a capability: whoever presents it over `join.token` or as a
 * bearer token on the HTTP API edits; everyone else with the link reads. Only the SHA-256 of the token is
 * stored, next to the document as `<id>.access.json`, never inside the shared Yjs document that every
 * reader receives. Projects created before access records existed have no record and stay open.
 */
export type AccessRecord = { v: 1; editTokenHash: string; createdAt: string };
export const DEMO_PROJECT_ID = "default";
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 2000;

export const mintEditToken = () => randomBytes(24).toString("base64url");
export const isUsableToken = (token: unknown): token is string =>
  typeof token === "string" && token.length >= MIN_TOKEN_LENGTH && token.length <= MAX_TOKEN_LENGTH;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

export function accessRecord(token: string, now: () => number = Date.now): AccessRecord {
  return { v: 1, editTokenHash: digest(token).toString("hex"), createdAt: new Date(now()).toISOString() };
}
export function parseAccessRecord(raw: unknown): AccessRecord {
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as AccessRecord).v === 1 &&
    typeof (raw as AccessRecord).editTokenHash === "string" &&
    /^[0-9a-f]{64}$/.test((raw as AccessRecord).editTokenHash) &&
    typeof (raw as AccessRecord).createdAt === "string"
  )
    return raw as AccessRecord;
  throw new Error("Malformed access record");
}
export function tokenMatches(record: AccessRecord, token: unknown): boolean {
  if (!isUsableToken(token)) return false;
  const expected = Buffer.from(record.editTokenHash, "hex");
  const actual = digest(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** Constant-time comparison for shared secrets such as ADMIN_TOKEN; an unset secret never matches. */
export function secretMatches(expected: string | undefined, actual: unknown): boolean {
  if (!expected || typeof actual !== "string") return false;
  return timingSafeEqual(digest(expected), digest(actual));
}
/** The shared demo is always view only; a project without a record is a legacy open project. */
export function roleFor(projectId: string, record: AccessRecord | null, token: unknown): CollabRole {
  if (projectId === DEMO_PROJECT_ID) return "viewer";
  if (!record) return "editor";
  return tokenMatches(record, token) ? "editor" : "viewer";
}
/** `Authorization: Bearer <token>`; anything else is treated as no token. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(\S+)\s*$/i);
  return match?.[1];
}
