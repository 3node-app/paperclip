/**
 * Renders the Briefing page UI with a curated fixture set and writes
 * desktop + mobile + empty-state PNG snapshots into
 * `docs/pr-screenshots/pap-9963/`.
 *
 * Skipped by default — set `BRIEFS_CAPTURE_SCREENSHOTS=1` to opt in.
 *
 * The flag avoids dragging Playwright into the regular fast unit-test run while
 * still letting CI / agents capture deterministic fixtures from the same view
 * components the host renders.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/plugin-sdk/ui", () => {
  return {
    useHostNavigation: () => ({
      resolveHref: (to: string) => to,
      navigate: () => {},
      linkProps: (to: string) => ({ href: to, onClick: () => {} }),
    }),
    usePluginAction: () => vi.fn(async () => ({ ok: true })),
    usePluginData: () => ({ data: null, loading: false, error: null, refresh: () => {} }),
    usePluginToast: () => vi.fn(),
    useHostLocation: () => ({ pathname: "/PAP/briefs", search: "", hash: "" }),
    usePluginStream: () => ({ events: [], lastEvent: null, connecting: false, connected: false, error: null, close: () => {} }),
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { BriefCardView } from "../../src/ui/app.js";
import { groupCardsIntoSections } from "../../src/ui/view-model.js";
import { gallery } from "./fixtures.js";

const ENABLED = process.env.BRIEFS_CAPTURE_SCREENSHOTS === "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../../../..");
const outDir = path.resolve(repoRoot, "docs/pr-screenshots/pap-9963");

const desktopWidth = 1440;
const mobileWidth = 390;

function staticPage({ cards, viewportWidth }: { cards: ReturnType<typeof gallery>; viewportWidth: number }) {
  const isMobile = viewportWidth < 700;
  const sections = groupCardsIntoSections(cards);
  const visibleSections = isMobile
    ? sections.filter((section) => section.cards.length > 0).slice(0, 1).concat(sections.slice(1))
    : sections;
  const active = cards.filter((c) => !c.hidden);
  const pinned = active.filter((c) => c.pinned).length;
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <title>Briefing — ${isMobile ? "mobile" : "desktop"}</title>
      <style>
        :root {
          --background: oklch(0.145 0 0);
          --foreground: oklch(0.985 0 0);
          --card: oklch(0.205 0 0);
          --border: oklch(0.269 0 0);
          --muted-foreground: oklch(0.708 0 0);
          --primary: oklch(0.985 0 0);
          --primary-foreground: oklch(0.205 0 0);
          --secondary: oklch(0.269 0 0);
          --accent: oklch(0.269 0 0);
        }
        html, body { background: var(--background); color: var(--foreground); margin: 0; min-height: 100vh; }
        body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
        a { color: inherit; }
        @media (max-width: 700px) {
          [data-briefs-mobile-tabs] { display: flex !important; }
          [data-briefs-section] > header { display: none; }
          [data-briefs-section][data-mobile-hidden="true"] { display: none; }
          [data-briefs-grid] { grid-template-columns: 1fr !important; }
        }
      </style>
    </head>
    <body>
      <div style="font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; color: var(--foreground); padding: 20px clamp(12px, 4vw, 32px); max-width: 1280px; margin: 0 auto; min-height: 100vh;">
        <header style="display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 6px;">
          <h1 style="margin: 0; font-size: 22px; font-weight: 600;">Briefing</h1>
          <div style="flex: 1; min-width: 0; font-size: 12px; color: var(--muted-foreground);">${active.length} active · ${pinned} pinned · refreshed just now</div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button style="padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--card); color: var(--foreground); font-size: 12px;">Preferences</button>
            <button style="padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--card); color: var(--foreground); font-size: 12px;">Refresh</button>
          </div>
        </header>
        <p style="margin: 0; margin-bottom: 18px; font-size: 13px; color: var(--muted-foreground);">Durable cards for areas of work that involve you. Pin the ones you always want to see.</p>
        ${active.length === 0
          ? `<div data-briefs-empty style="padding: 40px 24px; border: 1px dashed var(--border); border-radius: 10px; text-align: center; color: var(--muted-foreground);">
              <div style="font-size: 15px; color: var(--foreground); font-weight: 600; margin-bottom: 4px;">No briefs yet</div>
              <div style="font-size: 13px;">Cards appear here once the Briefing Analyst picks up recent work. Pinned cards never expire.</div>
            </div>`
          : visibleSections.map((section) => section.cards.length === 0 ? "" : `
            <section data-briefs-section="${section.key}" style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px;">
              <header style="display: flex; align-items: center; gap: 10px;">
                <h2 style="margin: 0; font-size: 12px; letter-spacing: 0.6px; color: var(--muted-foreground); text-transform: uppercase; font-weight: 600;">${section.label}</h2>
                <span style="font-size: 12px; color: var(--muted-foreground);">${section.cards.length}</span>
                <span style="flex: 1; border-bottom: 1px dashed var(--border);"></span>
              </header>
              <div data-briefs-grid style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 360px), 1fr)); gap: 12px;">
                ${section.cards.map((card) => renderToStaticMarkup(<BriefCardView card={card} onChanged={() => {}} />)).join("")}
              </div>
            </section>
          `).join("")}
      </div>
    </body>
  </html>`;
}

describe.skipIf(!ENABLED)("Briefs screenshots", () => {
  let browser: import("playwright").Browser | null = null;

  async function getBrowser() {
    if (browser) return browser;
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch({ headless: true });
    return browser;
  }

  afterAll(async () => {
    if (browser) await browser.close();
  });

  it("captures desktop, mobile, and empty-state Briefing snapshots", async () => {
    await fs.mkdir(outDir, { recursive: true });
    const tmpDir = await fs.mkdtemp(path.join(__dirname, ".tmp-briefs-"));
    const cards = gallery();

    const desktopHtml = staticPage({ cards, viewportWidth: desktopWidth });
    const mobileHtml = staticPage({ cards, viewportWidth: mobileWidth });
    const emptyHtml = staticPage({ cards: [], viewportWidth: desktopWidth });

    const desktopFile = path.join(tmpDir, "briefing-desktop.html");
    const mobileFile = path.join(tmpDir, "briefing-mobile.html");
    const emptyFile = path.join(tmpDir, "briefing-empty.html");
    await fs.writeFile(desktopFile, desktopHtml);
    await fs.writeFile(mobileFile, mobileHtml);
    await fs.writeFile(emptyFile, emptyHtml);

    const browser = await getBrowser();

    await snap(browser, desktopFile, { width: desktopWidth, height: 900 }, path.join(outDir, "briefing-desktop.png"));
    await snap(browser, mobileFile, { width: mobileWidth, height: 844 }, path.join(outDir, "briefing-mobile.png"));
    await snap(browser, emptyFile, { width: desktopWidth, height: 700 }, path.join(outDir, "briefing-empty.png"));

    for (const name of ["briefing-desktop.png", "briefing-mobile.png", "briefing-empty.png"]) {
      const stats = await fs.stat(path.join(outDir, name));
      expect(stats.size).toBeGreaterThan(1024);
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 60_000);
});

async function snap(browser: import("playwright").Browser, htmlPath: string, viewport: { width: number; height: number }, out: string): Promise<void> {
  const context = await browser.newContext({ viewport, colorScheme: "dark" });
  const page = await context.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: out, fullPage: true });
  await context.close();
}
