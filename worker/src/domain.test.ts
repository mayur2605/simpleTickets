import { describe, it, expect } from "vitest";
import {
  extractAddress,
  isApprovedSender,
  htmlToText,
  APPROVED_DOMAIN,
} from "./domain";

describe("extractAddress", () => {
  it("takes the address out of a display-name header", () => {
    expect(extractAddress('"Ananya Rao" <ananya.rao@allcheckservices.com>')).toBe(
      "ananya.rao@allcheckservices.com",
    );
  });

  it("accepts a bare address", () => {
    expect(extractAddress("ananya.rao@allcheckservices.com")).toBe(
      "ananya.rao@allcheckservices.com",
    );
  });

  it("lowercases, so comparisons are case-insensitive", () => {
    expect(extractAddress("Ananya.Rao@AllCheckServices.COM")).toBe(
      "ananya.rao@allcheckservices.com",
    );
  });

  it("returns null when there is no address", () => {
    expect(extractAddress("")).toBeNull();
    expect(extractAddress("not an address")).toBeNull();
  });
});

describe("isApprovedSender — R01, exact domain only", () => {
  it("accepts the company domain", () => {
    expect(isApprovedSender(`someone@${APPROVED_DOMAIN}`)).toBe(true);
  });

  it("accepts it regardless of case", () => {
    expect(isApprovedSender("SOMEONE@ALLCHECKSERVICES.COM")).toBe(true);
  });

  it("rejects a lookalike suffix", () => {
    // The spec calls this out by name: allcheckservices.com.example.org
    expect(isApprovedSender("attacker@allcheckservices.com.example.org")).toBe(false);
  });

  it("rejects a domain that merely ends with ours", () => {
    expect(isApprovedSender("attacker@notallcheckservices.com")).toBe(false);
    expect(isApprovedSender("attacker@xallcheckservices.com")).toBe(false);
  });

  it("rejects a subdomain, because R01 says exactly this domain", () => {
    expect(isApprovedSender("someone@mail.allcheckservices.com")).toBe(false);
  });

  it("rejects other domains and rubbish", () => {
    expect(isApprovedSender("someone@gmail.com")).toBe(false);
    expect(isApprovedSender("")).toBe(false);
    expect(isApprovedSender("no-at-sign")).toBe(false);
    expect(isApprovedSender("two@at@signs.allcheckservices.com")).toBe(false);
  });

  it("accepts a full header, not just a bare address", () => {
    expect(isApprovedSender('"Rao, Ananya" <ananya@allcheckservices.com>')).toBe(true);
    expect(isApprovedSender('"allcheckservices.com" <attacker@evil.example>')).toBe(false);
  });
});

describe("htmlToText — HTML-only mail must be readable on a ticket", () => {
  it("keeps the text and drops the markup", () => {
    expect(
      htmlToText('<html><body><div style="font-size:12pt">VPN is down</div></body></html>'),
    ).toBe("VPN is down");
  });

  it("turns block ends and breaks into line breaks", () => {
    expect(htmlToText("<p>First</p><p>Second</p>")).toBe("First\n\nSecond");
    expect(htmlToText("One<br>Two")).toBe("One\nTwo");
  });

  it("removes script and style content entirely", () => {
    expect(htmlToText("<style>p{color:red}</style><p>Visible</p>")).toBe("Visible");
    expect(htmlToText("<script>alert(1)</script><p>Visible</p>")).toBe("Visible");
  });

  it("decodes the entities that actually turn up in mail", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &lt;tag&gt; &quot;quoted&quot;</p>")).toBe(
      'Tom & Jerry <tag> "quoted"',
    );
  });

  it("collapses the blank-line pileup that nested markup produces", () => {
    expect(htmlToText("<div>A</div><div></div><div></div><div>B</div>")).toBe("A\n\nB");
  });

  it("leaves plain text alone", () => {
    expect(htmlToText("Just plain text")).toBe("Just plain text");
  });
});
