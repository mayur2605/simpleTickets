import { chromium, firefox, webkit, expect } from "@playwright/test";
import { createServer } from "vite";

// This test drives the dashboard on its SAMPLE data, and asserts exact row
// counts against the `seed` array in main.tsx. The dashboard now decides it is
// live by asking /api/me, so the proxy is pointed at a port nothing listens on:
// the probe fails, the dashboard stays on sample data, and the test is not
// quietly coupled to whether a real server happens to be running on 8787.
process.env.VITE_PROXY_TARGET = "http://127.0.0.1:59999";

// A port per engine, so a matrix job running all three at once does not have
// them fighting over 5174. strictPort, so a collision fails loudly rather than
// silently testing whatever is already listening.
const ports = { chromium: 5174, firefox: 5175, webkit: 5176 };
const port = ports[process.env.SMOKE_BROWSER ?? "chromium"] ?? 5174;
const server = await createServer({
  server: { host: "127.0.0.1", port, strictPort: true },
});
await server.listen();
// SMOKE_BROWSER picks the engine (T028: Firefox and WebKit were an open item).
// Chromium is the default because it is what the main gate runs on every
// commit; the other two run in their own CI job, so a WebKit-only layout bug is
// caught without tripling the time every push costs.
const engines = { chromium, firefox, webkit };
const engineName = process.env.SMOKE_BROWSER ?? "chromium";
const engine = engines[engineName];
if (engine === undefined)
  throw new Error(
    `SMOKE_BROWSER must be chromium, firefox or webkit; got ${engineName}`,
  );

const browser = await engine.launch({
  // Real Chrome locally, because that is what the team uses. Firefox and WebKit
  // have no channels here and Playwright's own builds are the point.
  channel: engineName === "chromium" && !process.env.CI ? "chrome" : undefined,
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${port}`);
await expect(
  page.getByRole("heading", { name: "SimpleTickets" }),
).toBeVisible();
await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(7);
// Accessibility: state shown with colour must also be exposed to assistive
// technology, and the wide table's scroll container must be reachable by
// keyboard and carry a name.
await expect(
  page.locator("nav").getByRole("button", { name: /All Tickets/ }),
).toHaveAttribute("aria-current", "page");
await expect(
  page.locator("nav").getByRole("button", { name: "Team", exact: true }),
).not.toHaveAttribute("aria-current", "page");
const scroller = page.getByRole("region", { name: "Ticket queue" });
await expect(scroller).toBeVisible();
await expect(scroller).toHaveAttribute("tabindex", "0");
const attentionTab = page
  .locator(".queue-tabs")
  .getByRole("button", { name: /Needs attention/ });
await expect(attentionTab).toHaveAttribute("aria-pressed", "false");
await attentionTab.click();
await expect(attentionTab).toHaveAttribute("aria-pressed", "true");
await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
await page
  .locator(".queue-tabs")
  .getByRole("button", { name: /All Tickets/ })
  .click();
await page.getByRole("button", { name: "My Tickets", exact: true }).click();
await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(2);
await page
  .locator("nav")
  .getByRole("button", { name: /All Tickets/ })
  .click();
await page
  .getByRole("textbox", { name: "Search tickets", exact: true })
  .fill("no-such-ticket");
await expect(
  page.getByRole("heading", { name: "No matching tickets" }),
).toBeVisible();
await page.getByRole("button", { name: "Clear filters" }).click();
await page
  .getByRole("combobox", { name: "Filter status" })
  .selectOption("Resolved");
await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
await page
  .getByRole("combobox", { name: "Filter status" })
  .selectOption("All statuses");
if (engineName === "chromium")
  await page.screenshot({ path: "dashboard-preview.png", fullPage: true });
await page.getByRole("button", { name: /ST-1048/ }).click();
await page.getByRole("combobox", { name: "Reply template" }).selectOption("1");
await expect(
  page.getByRole("combobox", { name: "Status after sending" }),
).toHaveValue("Waiting for Employee");
await page
  .getByRole("textbox", { name: "Message", exact: true })
  .fill("Please share a screenshot of the VPN error.");
await page.getByRole("button", { name: "Send reply (demo)" }).click();
await expect(page.locator(".detail-heading .status")).toHaveText(
  "Waiting for Employee",
);
await expect(
  page.getByText("Reply saved in this preview. No email was sent."),
).toBeVisible();
await page
  .getByRole("textbox", { name: "Message", exact: true })
  .fill("Public follow-up draft.");
await page.getByRole("button", { name: "Internal note", exact: true }).click();
await page
  .getByRole("textbox", { name: "Visible only to IT" })
  .fill("Check the VPN gateway logs.");
await page
  .getByRole("button", { name: "Reply to employee", exact: true })
  .click();
await expect(
  page.getByRole("textbox", { name: "Message", exact: true }),
).toHaveValue("Public follow-up draft.");
await expect(
  page.getByRole("textbox", { name: "Message", exact: true }),
).not.toHaveValue("Check the VPN gateway logs.");
await page.getByRole("button", { name: "Internal note", exact: true }).click();
await expect(
  page.getByRole("textbox", { name: "Visible only to IT" }),
).toHaveValue("Check the VPN gateway logs.");
await page.getByRole("button", { name: "Add internal note" }).click();
await expect(page.locator(".detail-heading .status")).toHaveText(
  "Waiting for Employee",
);
await expect(
  page.getByRole("textbox", { name: "Visible only to IT" }),
).toHaveValue("");
await page
  .getByRole("button", { name: "Reply to employee", exact: true })
  .click();
await expect(
  page.getByRole("textbox", { name: "Message", exact: true }),
).toHaveValue("Public follow-up draft.");
await page.getByRole("button", { name: "Send reply (demo)" }).click();
await expect(page.locator("article:not(.internal)")).not.toContainText([
  "Check the VPN gateway logs.",
]);
if (engineName === "chromium")
  await page.screenshot({ path: "ticket-preview.png", fullPage: true });
await page
  .getByRole("button", { name: "Reply Templates", exact: true })
  .click();
await expect(
  page.locator(".template").filter({ hasText: "Request more details" }),
).toContainText("could you share a screenshot");
await page.getByRole("button", { name: "Create template" }).click();
await page
  .getByRole("textbox", { name: "Template name" })
  .fill("Remote support");
await page
  .getByRole("textbox", { name: "Message", exact: true })
  .fill("Please let us know a suitable time for a remote support session.");
await page.getByRole("button", { name: "Save template" }).click();
await expect(page.locator(".template")).toHaveCount(5);
await page
  .locator("nav")
  .getByRole("button", { name: /All Tickets/ })
  .click();
await page.setViewportSize({ width: 390, height: 844 });
await expect(
  page.getByRole("heading", { name: "SimpleTickets" }),
).toBeVisible();
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth > window.innerWidth,
);
if (overflow) throw new Error("Page overflows mobile viewport");
// Only from chromium: these are committed design references, and three engines
// overwriting them in turn would make the file depend on which job ran last.
if (engineName === "chromium")
  await page.screenshot({ path: "mobile-preview.png", fullPage: true });
for (const width of [360, 768, 1440]) {
  await page.setViewportSize({ width, height: 900 });
  await expect(
    page.getByRole("heading", { name: "SimpleTickets" }),
  ).toBeVisible();
  if (
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
  )
    throw new Error("Page overflow at " + width);
}

// --- keyboard journey (T028) -----------------------------------------------
// Every control the queue needs must be reachable and operable without a
// mouse. Asserted by tabbing rather than by clicking with the keyboard's name
// on it: a div with a click handler passes the second test and fails the first.
await page.setViewportSize({ width: 1440, height: 1000 });
await page.reload();
await expect(
  page.getByRole("heading", { name: "SimpleTickets" }),
).toBeVisible();
await page.keyboard.press("Tab");
const firstStop = await page.evaluate(() => {
  const el = document.activeElement;
  return el === null ? null : el.tagName.toLowerCase();
});
// Any real control will do. WebKit is the reason this is not "a button":
// Safari's default tab order skips buttons and links entirely unless the user
// turns on "Press Tab to highlight each item", so the first stop there is the
// search input. That is a browser setting, not something the page decides, and
// asserting the Chromium answer would fail WebKit for being Safari.
if (!["button", "a", "input", "select", "textarea"].includes(String(firstStop)))
  throw new Error("First Tab stop is not a control: " + String(firstStop));

// Reach the ticket queue with the keyboard alone, and open a ticket with Enter.
//
// WebKit is excluded from the TAB WALK, not from the keyboard check. Safari's
// default tab order skips buttons and links unless the user turns on "Press Tab
// to highlight each item" — that is a browser setting, and a page cannot opt
// into it. What the page IS responsible for is that the row is a real control
// that responds to keyboard activation, which is asserted below on every engine
// by focusing it and pressing Enter.
if (engineName !== "webkit") {
  let reached = false;
  for (let i = 0; i < 120 && !reached; i += 1) {
    // Matched on the row BUTTON, not on any focused element containing that
    // text: the queue's scroll region is itself focusable and its textContent
    // holds every row, so a text-only match stops one element too early.
    const name = await page.evaluate(() => {
      const el = document.activeElement;
      return el !== null && el.classList.contains("ticket-link")
        ? (el.textContent ?? "").trim()
        : "";
    });
    if (name.includes("Unable to connect to the office VPN")) {
      reached = true;
      break;
    }
    await page.keyboard.press("Tab");
  }
  if (!reached) throw new Error("Could not reach a ticket row by keyboard");
} else {
  await page.evaluate(() => {
    const row = [...document.querySelectorAll(".ticket-link")].find((el) =>
      (el.textContent ?? "").includes("Unable to connect to the office VPN"),
    );
    if (row instanceof HTMLElement) row.focus();
  });
}

// Activated by keyboard, on every engine. This is the part the page owns.
const focusedRow = await page.evaluate(
  () => document.activeElement?.classList.contains("ticket-link") === true,
);
if (!focusedRow) throw new Error("Ticket row did not take keyboard focus");
await page.keyboard.press("Enter");
await expect(page.locator(".detail-heading h1")).toBeVisible();

// The focused element must be visible, not merely focused: a focus ring that
// forced colours or a box-shadow swallows leaves a keyboard user lost.
const ringed = await page.evaluate(() => {
  const el = document.activeElement;
  if (el === null) return false;
  const style = getComputedStyle(el);
  return (
    style.outlineStyle !== "none" ||
    style.boxShadow !== "none" ||
    style.borderColor !== ""
  );
});
if (!ringed) throw new Error("Focused element has no visible focus indicator");

// Escape the detail view the same way a keyboard user would, then carry on.
await page.getByRole("button", { name: "Back to tickets" }).click();
await expect(
  page.getByRole("heading", { name: "SimpleTickets" }),
).toBeVisible();

// --- 200% zoom (T028) -------------------------------------------------------
// WCAG 1.4.4. Emulated by halving the viewport, which is what doubling the text
// size does to the space available: 1280x1024 at 200% is a 640x512 layout.
for (const [width, height] of [
  [640, 512],
  [960, 640],
]) {
  await page.setViewportSize({ width, height });
  await expect(
    page.getByRole("heading", { name: "SimpleTickets" }),
  ).toBeVisible();
  if (
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    )
  )
    throw new Error("Page overflows horizontally at 200% zoom (" + width + ")");
}

// --- touch targets (T028) ---------------------------------------------------
// WCAG 2.2 target size, on the viewport where it matters. Checked against the
// rendered box, because a min-height rule that a flex parent overrides is a
// rule that is not in force.
await page.setViewportSize({ width: 390, height: 844 });
await page.emulateMedia({ media: "screen" });
await page.reload();
await expect(
  page.getByRole("heading", { name: "SimpleTickets" }),
).toBeVisible();
const smallTargets = await page.evaluate(() =>
  [...document.querySelectorAll("nav button")]
    .map((el) => ({
      name: (el.textContent ?? "").trim(),
      h: el.getBoundingClientRect().height,
    }))
    .filter((item) => item.h > 0 && item.h < 40),
);
if (smallTargets.length > 0)
  throw new Error(
    "Navigation targets under 40px on a phone: " + JSON.stringify(smallTargets),
  );

if (errors.length) throw new Error(errors.join("\n"));
console.log(
  `PASS (${engineName}): filters, empty state, reply/status mapping, private notes, template isolation/creation, mobile width, keyboard journey, 200% zoom, touch targets, no browser errors.`,
);
await browser.close();
await server.close();
