import { describe, it, expect } from "vitest";
import {
  addWorkingHours,
  responseDeadline,
  pendingDeadline,
} from "./business-calendar";

// Fixtures are written as IST wall-clock with an explicit offset, so the
// intended local time is readable and the stored value stays UTC.
// 2026-09-12 Sat · 09-13 Sun · 09-14 Mon · 09-15 Tue · 09-19 Sat · 09-20 Sun · 09-21 Mon
const ist = (iso: string): Date => new Date(`${iso}+05:30`);
const istString = (d: Date): string =>
  d.toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" });

describe("responseDeadline — R16/R17 spec examples", () => {
  it("Monday 10:00 is due Monday 14:00", () => {
    expect(istString(responseDeadline(ist("2026-09-14T10:00:00")))).toBe(
      "2026-09-14 14:00:00",
    );
  });

  it("Monday 16:00 is due Tuesday 11:00, carrying two hours overnight", () => {
    expect(istString(responseDeadline(ist("2026-09-14T16:00:00")))).toBe(
      "2026-09-15 11:00:00",
    );
  });

  it("Saturday 16:00 is due Monday 11:00, skipping Sunday", () => {
    expect(istString(responseDeadline(ist("2026-09-12T16:00:00")))).toBe(
      "2026-09-14 11:00:00",
    );
  });

  it("a Sunday arrival starting a new episode is due Monday 12:00", () => {
    expect(istString(responseDeadline(ist("2026-09-13T10:00:00")))).toBe(
      "2026-09-14 12:00:00",
    );
  });

  it("applies the Sunday rule regardless of the hour it arrived", () => {
    expect(istString(responseDeadline(ist("2026-09-13T23:30:00")))).toBe(
      "2026-09-14 12:00:00",
    );
  });
});

describe("responseDeadline — outside working hours", () => {
  it("starts the clock at 09:00 for an early-morning arrival", () => {
    expect(istString(responseDeadline(ist("2026-09-14T07:00:00")))).toBe(
      "2026-09-14 13:00:00",
    );
  });

  it("carries an after-hours arrival to the next working day", () => {
    expect(istString(responseDeadline(ist("2026-09-14T19:00:00")))).toBe(
      "2026-09-15 13:00:00",
    );
  });

  it("treats 18:00 exactly as after hours", () => {
    expect(istString(responseDeadline(ist("2026-09-14T18:00:00")))).toBe(
      "2026-09-15 13:00:00",
    );
  });

  it("counts 09:00 exactly as working time", () => {
    expect(istString(responseDeadline(ist("2026-09-14T09:00:00")))).toBe(
      "2026-09-14 13:00:00",
    );
  });

  it("carries a Saturday evening arrival past Sunday to Monday", () => {
    expect(istString(responseDeadline(ist("2026-09-19T19:00:00")))).toBe(
      "2026-09-21 13:00:00",
    );
  });

  it("returns a UTC instant, not a local-time string", () => {
    expect(responseDeadline(ist("2026-09-14T10:00:00")).toISOString()).toBe(
      "2026-09-14T08:30:00.000Z",
    );
  });
});

describe("pendingDeadline — an earlier deadline is never postponed (R16/R17)", () => {
  it("keeps an existing Monday 11:00 when a Sunday follow-up arrives", () => {
    const existing = ist("2026-09-14T11:00:00");
    expect(
      istString(pendingDeadline(existing, ist("2026-09-13T10:00:00"))),
    ).toBe("2026-09-14 11:00:00");
  });

  it("keeps an existing deadline when a later working-hours message arrives", () => {
    const existing = ist("2026-09-14T11:00:00");
    expect(
      istString(pendingDeadline(existing, ist("2026-09-14T10:00:00"))),
    ).toBe("2026-09-14 11:00:00");
  });

  it("starts a new episode when nothing is pending", () => {
    expect(istString(pendingDeadline(null, ist("2026-09-14T10:00:00")))).toBe(
      "2026-09-14 14:00:00",
    );
  });

  it("takes the new deadline when it falls earlier than the existing one", () => {
    const existing = ist("2026-09-15T17:00:00");
    expect(
      istString(pendingDeadline(existing, ist("2026-09-14T10:00:00"))),
    ).toBe("2026-09-14 14:00:00");
  });
});

describe("addWorkingHours — reusable for R18 reminder intervals", () => {
  it("adds hours within a single working day", () => {
    expect(istString(addWorkingHours(ist("2026-09-14T09:30:00"), 4))).toBe(
      "2026-09-14 13:30:00",
    );
  });

  it("spans multiple days for a long interval", () => {
    // Two full 9-hour working days: Mon 09:00-18:00, then Tue 09:00-18:00.
    expect(istString(addWorkingHours(ist("2026-09-14T09:00:00"), 18))).toBe(
      "2026-09-15 18:00:00",
    );
  });

  it("lands on 18:00 rather than rolling into the next working day", () => {
    // Close of business is a valid deadline instant. Rolling it forward would
    // hand the team an extra overnight they have not earned.
    expect(istString(addWorkingHours(ist("2026-09-14T14:00:00"), 4))).toBe(
      "2026-09-14 18:00:00",
    );
  });

  it("returns the start of the next working window for a zero interval outside hours", () => {
    expect(istString(addWorkingHours(ist("2026-09-13T10:00:00"), 0))).toBe(
      "2026-09-14 09:00:00",
    );
  });
});
