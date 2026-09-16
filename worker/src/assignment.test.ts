import { describe, it, expect } from "vitest";
import { chooseAssignee, type StaffWorkload } from "./assignment";

const staff = (rows: [string, number, boolean?][]): StaffWorkload[] =>
  rows.map(([name, openTickets, available = true]) => ({ name, openTickets, available }));

describe("chooseAssignee", () => {
  it("picks whoever has fewest open tickets", () => {
    expect(
      chooseAssignee(
        staff([
          ["asha", 5],
          ["ben", 2],
          ["chi", 4],
        ]),
        null,
      ),
    ).toBe("ben");
  });

  it("skips unavailable staff even when they have the lightest load", () => {
    expect(
      chooseAssignee(
        staff([
          ["asha", 9],
          ["ben", 0, false],
        ]),
        null,
      ),
    ).toBe("asha");
  });

  // Nobody available means the ticket stays unassigned and admin is alerted -
  // silently handing it to an unavailable person would look assigned and never
  // be worked.
  it("returns null when nobody is available", () => {
    expect(
      chooseAssignee(
        staff([
          ["asha", 1, false],
          ["ben", 0, false],
        ]),
        null,
      ),
    ).toBeNull();
    expect(chooseAssignee([], null)).toBeNull();
  });

  // Ties rotate, so a quiet queue does not always land on whoever sorts first.
  it("rotates between tied staff", () => {
    const tied = staff([
      ["asha", 3],
      ["ben", 3],
      ["chi", 3],
    ]);
    expect(chooseAssignee(tied, null)).toBe("asha");
    expect(chooseAssignee(tied, "asha")).toBe("ben");
    expect(chooseAssignee(tied, "ben")).toBe("chi");
    expect(chooseAssignee(tied, "chi")).toBe("asha");
  });

  it("rotates only among the tied-lowest, never to a busier person", () => {
    const rows = staff([
      ["asha", 1],
      ["ben", 1],
      ["chi", 0],
    ]);
    // chi is strictly lowest, so rotation does not apply at all.
    expect(chooseAssignee(rows, "chi")).toBe("chi");
  });

  it("ignores a last assignee who is no longer available", () => {
    const rows = staff([
      ["asha", 2],
      ["ben", 2],
      ["gone", 0, false],
    ]);
    expect(chooseAssignee(rows, "gone")).toBe("asha");
  });

  it("is deterministic for the same inputs", () => {
    const rows = staff([
      ["ben", 2],
      ["asha", 2],
    ]);
    expect(chooseAssignee(rows, null)).toBe(chooseAssignee(rows, null));
  });

  // Order of the input list must not change the answer, or two callers reading
  // the same table in different orders would assign differently.
  it("does not depend on the order staff are listed in", () => {
    const a = chooseAssignee(
      staff([
        ["asha", 2],
        ["ben", 2],
        ["chi", 1],
      ]),
      null,
    );
    const b = chooseAssignee(
      staff([
        ["chi", 1],
        ["ben", 2],
        ["asha", 2],
      ]),
      null,
    );
    expect(a).toBe(b);
  });
});
