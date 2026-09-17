import { describe, it, expect } from "vitest";
import { splitAddressList, eligibleParticipants } from "./domain.ts";

/**
 * R25: which CC addresses may join a ticket, and which must not.
 *
 * The domain rule here is the same one that guards opening a ticket, and for a
 * stronger reason: a wrongly admitted sender opens one ticket, while a wrongly
 * admitted CC participant receives every public reply on somebody else's for as
 * long as it stays open.
 */
describe("splitAddressList", () => {
  it("splits an ordinary list", () => {
    expect(splitAddressList("a@x.test, b@x.test")).toEqual(["a@x.test", "b@x.test"]);
  });

  /**
   * A comma inside a quoted display name is not a separator. Splitting on it
   * turns one recipient into two, neither of which parses as an address - so
   * the colleague silently stops being copied.
   */
  it("does not split inside a quoted display name", () => {
    expect(splitAddressList('"Rao, Ananya" <ananya@x.test>, sam@x.test')).toEqual([
      '"Rao, Ananya" <ananya@x.test>',
      "sam@x.test",
    ]);
  });

  it("does not split inside angle brackets", () => {
    expect(splitAddressList("Ananya <ananya@x.test>")).toEqual(["Ananya <ananya@x.test>"]);
  });

  it("is empty for a missing header", () => {
    expect(splitAddressList(null)).toEqual([]);
    expect(splitAddressList("")).toEqual([]);
    expect(splitAddressList("  ,  ")).toEqual([]);
  });
});

describe("eligibleParticipants", () => {
  it("keeps company addresses and drops external ones", () => {
    const found = eligibleParticipants(
      "ananya.rao@allcheckservices.com, outside@gmail.com, sam@allcheckservices.com",
      [],
    );
    expect(found).toEqual(["ananya.rao@allcheckservices.com", "sam@allcheckservices.com"]);
  });

  /**
   * The lookalike cases the specification names. A suffix check would accept
   * every one of these, and each is a real phishing shape rather than a
   * hypothetical.
   */
  it("refuses lookalike domains", () => {
    expect(
      eligibleParticipants(
        [
          "a@allcheckservices.com.example.org",
          "b@mail.allcheckservices.com",
          "c@notallcheckservices.com",
          '"allcheckservices.com" <d@evil.test>',
        ].join(", "),
        [],
      ),
    ).toEqual([]);
  });

  it("is case-insensitive and deduplicates", () => {
    expect(eligibleParticipants("Sam@AllCheckServices.com, sam@allcheckservices.com", [])).toEqual([
      "sam@allcheckservices.com",
    ]);
  });

  // Copying the support mailbox on a reply to the support mailbox is how a
  // loop starts, and the requester is already the addressee.
  it("excludes the addresses the caller passes in", () => {
    expect(
      eligibleParticipants("ananya@allcheckservices.com, support@allcheckservices.com", [
        "Ananya@allcheckservices.com",
        "support@allcheckservices.com",
      ]),
    ).toEqual([]);
  });

  it("is empty when there is no Cc header at all", () => {
    expect(eligibleParticipants(null, [])).toEqual([]);
  });
});
