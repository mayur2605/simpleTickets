import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
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
if (errors.length) throw new Error(errors.join("\n"));
console.log(
  "PASS: filters, empty state, reply/status mapping, private notes, template isolation/creation, mobile width, no browser errors.",
);
await browser.close();
await server.close();
