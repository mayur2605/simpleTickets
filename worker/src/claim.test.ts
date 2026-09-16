import { describe, it, expect } from "vitest";
import { claimNextIntent } from "./store";

/**
 * A scripted stand-in for D1. It models no SQL - it only replays the answers
 * the two statements in claimNextIntent would get, which is exactly what the
 * control flow under test depends on.
 */
function fakeDb(candidate: unknown, changes: number): { db: D1Database; calls: string[] } {
  const calls: string[] = [];
  const db = {
    prepare(sql: string) {
      calls.push(sql.trim().split("\n")[0]?.trim() ?? "");
      return {
        bind() {
          return {
            first: () => Promise.resolve(candidate),
            run: () => Promise.resolve({ meta: { changes } }),
          };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, calls };
}

const row = {
  id: 7,
  ticket_id: 42,
  intent: "acknowledgement",
  recipient: "ananya.rao@allcheckservices.com",
  message_id: "<ack.42@simpletickets>",
  payload: "{}",
  attempts: 1,
  pending_status: null,
};

describe("claimNextIntent", () => {
  it("returns nothing when no intent is due", async () => {
    const { db, calls } = fakeDb(null, 0);
    expect(await claimNextIntent(db, new Date())).toBeNull();
    // It must not attempt the claim when there was nothing to claim.
    expect(calls).toHaveLength(1);
  });

  it("returns the claimed intent when the update wins", async () => {
    const { db } = fakeDb(row, 1);
    const claimed = await claimNextIntent(db, new Date());
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(7);
    expect(claimed?.ticketId).toBe(42);
    // attempts is reported post-increment, so the caller's retry accounting
    // counts the attempt now in flight.
    expect(claimed?.attempts).toBe(2);
  });

  // THE important case. Two overlapping runs read the same pending row; the
  // conditional UPDATE matches for only one of them. The loser must back off,
  // not send. Without this the employee receives the message twice.
  it("returns nothing when another run claimed the row first", async () => {
    const { db, calls } = fakeDb(row, 0);
    expect(await claimNextIntent(db, new Date())).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("UPDATE outbox");
  });
});
