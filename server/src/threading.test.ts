import { describe, it, expect } from "vitest";
import { parseMessageIds, threadCandidates } from "./threading.ts";

describe("parseMessageIds", () => {
  it("reads a single id", () => {
    expect(parseMessageIds("<abc@mail.gmail.com>")).toEqual(["<abc@mail.gmail.com>"]);
  });

  it("reads a whitespace separated chain", () => {
    expect(parseMessageIds("<a@x> <b@x> <c@x>")).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  // Long References headers are folded across lines by the sending client.
  it("handles a header folded across lines", () => {
    expect(parseMessageIds("<a@x>\r\n <b@x>\r\n\t<c@x>")).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
  });

  it("ignores commentary between ids rather than choking on it", () => {
    expect(parseMessageIds("<a@x>, and also <b@x>")).toEqual(["<a@x>", "<b@x>"]);
  });

  it("returns nothing for absent or unusable headers", () => {
    expect(parseMessageIds(null)).toEqual([]);
    expect(parseMessageIds(undefined)).toEqual([]);
    expect(parseMessageIds("")).toEqual([]);
    expect(parseMessageIds("no angle brackets here")).toEqual([]);
  });

  it("does not return an empty id", () => {
    expect(parseMessageIds("<>")).toEqual([]);
  });
});

describe("threadCandidates", () => {
  // In-Reply-To names the immediate parent, so it is the strongest signal and
  // must be tried first.
  it("puts In-Reply-To ahead of the References chain", () => {
    expect(threadCandidates("<parent@x>", "<root@x> <mid@x> <parent@x>")).toEqual([
      "<parent@x>",
      "<mid@x>",
      "<root@x>",
    ]);
  });

  // References runs oldest first; the newest entries are the closest relatives,
  // so they are tried before the root.
  it("walks References newest first", () => {
    expect(threadCandidates(null, "<root@x> <mid@x> <leaf@x>")).toEqual([
      "<leaf@x>",
      "<mid@x>",
      "<root@x>",
    ]);
  });

  it("deduplicates without losing order", () => {
    expect(threadCandidates("<a@x>", "<a@x> <a@x> <b@x>")).toEqual(["<a@x>", "<b@x>"]);
  });

  it("returns nothing for a message that starts a thread", () => {
    expect(threadCandidates(null, null)).toEqual([]);
  });
});
