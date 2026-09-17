import { describe, it, expect } from "vitest";
import type { MessageStructureObject } from "imapflow";
import { findBodyPart } from "./imap.ts";

// Minimal stand-ins for imapflow's structure objects. Only the fields the
// selection logic reads are set.
function node(
  type: string,
  part?: string,
  childNodes?: MessageStructureObject[],
): MessageStructureObject {
  // The literal below already satisfies MessageStructureObject; no cast needed.
  return {
    type,
    ...(part === undefined ? {} : { part }),
    ...(childNodes === undefined ? {} : { childNodes }),
  };
}

describe("findBodyPart", () => {
  // The bug that cost the most time: a single-part message has NO part
  // identifier, so addressing it by one returns the entire raw message with
  // headers. "TEXT" is what addresses the body.
  it("uses TEXT for a single-part message that has no part id", () => {
    expect(findBodyPart(node("text/plain"))).toEqual({ part: "TEXT", type: "text/plain" });
  });

  it("prefers text/plain over text/html in a multipart/alternative", () => {
    const structure = node("multipart/alternative", undefined, [
      node("text/plain", "1"),
      node("text/html", "2"),
    ]);
    expect(findBodyPart(structure)).toEqual({ part: "1", type: "text/plain" });
  });

  // Gmail-composed mail is frequently HTML only. Returning null here would
  // leave the ticket body empty.
  it("falls back to text/html when there is no plain part", () => {
    const structure = node("multipart/alternative", undefined, [node("text/html", "1")]);
    expect(findBodyPart(structure)).toEqual({ part: "1", type: "text/html" });
  });

  it("finds the text inside a nested multipart with an attachment", () => {
    const structure = node("multipart/mixed", undefined, [
      node("multipart/alternative", "1", [node("text/plain", "1.1"), node("text/html", "1.2")]),
      node("application/pdf", "2"),
    ]);
    expect(findBodyPart(structure)).toEqual({ part: "1.1", type: "text/plain" });
  });

  it("prefers plain even when html appears earlier in the tree", () => {
    const structure = node("multipart/mixed", undefined, [
      node("text/html", "1"),
      node("text/plain", "2"),
    ]);
    expect(findBodyPart(structure)).toEqual({ part: "2", type: "text/plain" });
  });

  it("returns null when the message carries no text at all", () => {
    const structure = node("multipart/mixed", undefined, [
      node("application/pdf", "1"),
      node("image/png", "2"),
    ]);
    expect(findBodyPart(structure)).toBeNull();
  });

  it("returns null for an absent structure", () => {
    expect(findBodyPart(undefined)).toBeNull();
  });

  it("handles a node with no children without throwing", () => {
    expect(findBodyPart(node("application/pdf", "1"))).toBeNull();
  });
});
