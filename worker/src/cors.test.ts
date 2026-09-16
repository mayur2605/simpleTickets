import { describe, it, expect } from "vitest";
import { corsHeaders, ALLOWED_ORIGINS } from "./cors";

describe("corsHeaders", () => {
  it("allows the local dev server", () => {
    const headers = corsHeaders("http://127.0.0.1:5173");
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://127.0.0.1:5173");
  });

  it("allows the smoke-test server too", () => {
    expect(corsHeaders("http://127.0.0.1:5174")["Access-Control-Allow-Origin"]).toBe(
      "http://127.0.0.1:5174",
    );
  });

  // Reflecting any origin would let any website a staff member visits call this
  // API with their browser. The token stops it reading data, but there is no
  // reason to hand out the opportunity.
  it("refuses an unknown origin rather than reflecting it", () => {
    expect(corsHeaders("https://evil.test")["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders(null)["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("does not fall back to a wildcard", () => {
    for (const origin of ["https://evil.test", null, "", "null"]) {
      expect(corsHeaders(origin)["Access-Control-Allow-Origin"]).not.toBe("*");
    }
  });

  it("permits the admin token header, or the browser will not send it", () => {
    const headers = corsHeaders("http://127.0.0.1:5173");
    expect(headers["Access-Control-Allow-Headers"]).toContain("x-admin-token");
    expect(headers["Access-Control-Allow-Headers"]).toContain("content-type");
  });

  it("permits the methods the API actually uses", () => {
    const allowed = corsHeaders("http://127.0.0.1:5173")["Access-Control-Allow-Methods"] ?? "";
    expect(allowed).toContain("GET");
    expect(allowed).toContain("POST");
    expect(allowed).toContain("OPTIONS");
  });

  it("lists the origins it trusts", () => {
    expect(ALLOWED_ORIGINS).toContain("http://127.0.0.1:5173");
  });
});
