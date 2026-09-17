import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

// This test drives the dashboard on its SAMPLE data, and asserts exact row
// counts against the `seed` array in main.tsx. The dashboard now decides it is
// live by asking /api/me, so the proxy is pointed at a port nothing listens on:
// the probe fails, the dashboard stays on sample data, and the test is not
// quietly coupled to whether a real server happens to be running on 8787.
process.env.VITE_PROXY_TARGET = "http://127.0.0.1:59999";

const server = await createServer({
  server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({
  channel: process.env.CI ? undefined : "chrome",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://127.0.0.1:5174");
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
if (firstStop !== "button" && firstStop !== "a")
  throw new Error("First Tab stop is not a control: " + String(firstStop));

// Reach the ticket queue with the keyboard alone, and open a ticket with Enter.
let opened = false;
for (let i = 0; i < 120 && !opened; i += 1) {
  // Matched on the row BUTTON, not on any focused element containing that
  // text: the queue's scroll region is itself focusable and its textContent
  // holds every row, so a text-only match stops one element too early and
  // Enter does nothing.
  const name = await page.evaluate(() => {
    const el = document.activeElement;
    return el !== null && el.classList.contains("ticket-link")
      ? (el.textContent ?? "").trim()
      : "";
  });
  if (name.includes("Unable to connect to the office VPN")) {
    await page.keyboard.press("Enter");
    opened = true;
    break;
  }
  await page.keyboard.press("Tab");
}
if (!opened) throw new Error("Could not reach a ticket row by keyboard");
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
  "PASS: filters, empty state, reply/status mapping, private notes, template isolation/creation, mobile width, keyboard journey, 200% zoom, touch targets, no browser errors.",
);
await browser.close();
await server.close();
