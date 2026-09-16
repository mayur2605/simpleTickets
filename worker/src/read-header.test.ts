import { describe, it, expect } from "vitest";
import { readHeader } from "./imap";

// This regex was easy to get wrong and threading depends on it entirely: if it
// drops folded continuation lines, a long References chain loses its older half
// and a reply opens a new ticket instead of joining its conversation.
describe("readHeader", () => {
  const block =
    "Return-Path: <ananya.rao@allcheckservices.com>\r\n" +
    "In-Reply-To: <parent@mail.gmail.com>\r\n" +
    "References: <root@mail.gmail.com>\r\n" +
    " <mid@mail.gmail.com>\r\n" +
    "\t<leaf@mail.gmail.com>\r\n" +
    "Subject: Re: printer\r\n";

  it("reads a simple header", () => {
    expect(readHeader(block, "in-reply-to")).toBe("<parent@mail.gmail.com>");
  });

  it("is case insensitive, as header names are", () => {
    expect(readHeader(block, "IN-REPLY-TO")).toBe("<parent@mail.gmail.com>");
  });

  it("keeps every folded continuation line", () => {
    const references = readHeader(block, "references");
    expect(references).toContain("<root@mail.gmail.com>");
    expect(references).toContain("<mid@mail.gmail.com>");
    expect(references).toContain("<leaf@mail.gmail.com>");
  });

  it("stops at the next header rather than swallowing it", () => {
    expect(readHeader(block, "references")).not.toContain("Subject");
    expect(readHeader(block, "in-reply-to")).not.toContain("References");
  });

  it("returns null for a header that is not there", () => {
    expect(readHeader(block, "auto-submitted")).toBeNull();
    expect(readHeader("", "references")).toBeNull();
  });

  it("reads the last header in the block", () => {
    expect(readHeader(block, "subject")).toBe("Re: printer");
  });
});
