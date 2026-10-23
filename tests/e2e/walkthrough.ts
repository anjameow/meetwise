// Browser walkthrough of the full attendee + organiser flow against the local
// stack (scripts/local-db.sh + scripts/local-api.ts + scripts/seed-local.ts +
// `vite --host 127.0.0.1`). Time is simulated by moving the event schedule.
//   npx tsx tests/e2e/walkthrough.ts <event-slug> [screenshot-dir]
import { chromium, devices, type Page } from "playwright";
import pg from "pg";
import { SERVICE_KEY } from "../../scripts/local-api.ts";

const BASE = process.env.APP_URL ?? "http://127.0.0.1:8080";
const API = process.env.API_URL ?? "http://localhost:54321";
const slug = process.argv[2];
const out = process.argv[3] ?? "/tmp/meetwise-shots";
const db = new pg.Pool({ host: "/tmp", port: 54329, user: "postgres", database: "meetwise" });
let n = 0;

async function shot(page: Page, name: string) {
  await page.waitForTimeout(700);
  const file = `${out}/${String(++n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log("screenshot", file);
}
const scheduler = () => fetch(`${API}/functions/v1/scheduler`, { method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}` } }).then((r) => r.json());
const move = (sql: string) => db.query(sql, [slug]);

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  const phone = await browser.newContext({ ...devices["iPhone 13"] });
  const page = await phone.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR", e.message));

  await page.goto(BASE);
  await shot(page, "landing");

  await page.goto(`${BASE}/e/${slug}`);
  await page.getByRole("link", { name: "Join event" }).click();
  await page.getByRole("tab", { name: "Create account" }).waitFor();
  await page.getByLabel("Your name").fill("Jordan Rivera");
  await page.getByLabel("Email").fill(`jordan${Date.now()}@example.test`);
  await page.getByLabel("Password").fill("a-strong-password");
  await shot(page, "signup");
  await page.getByRole("button", { name: "Create account" }).click();

  await page.getByRole("heading", { name: /Penn Founders/ }).waitFor();
  await shot(page, "join-consent");
  await page.getByRole("button", { name: "Join event" }).click();

  // Profile wizard
  await page.getByRole("heading", { name: "Let's start with you" }).waitFor();
  await page.getByLabel("City").fill("Philadelphia");
  await page.getByLabel("Country").selectOption("United States");
  await shot(page, "wizard-basics");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Education status").selectOption("postgraduate");
  await page.getByLabel("University or school").fill("University of Pennsylvania");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Employment status").selectOption("job_seeking");
  await page.getByLabel("Job title").fill("MBA candidate");
  await page.getByLabel("Role", { exact: true }).selectOption("product");
  await page.getByLabel("Industry").selectOption("finance");
  await page.getByLabel("Career stage").selectOption("early_career");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Find my next role" }).click();
  await page.getByRole("button", { name: "Find a mentor" }).click();
  await page.getByRole("group", { name: "Target industries" }).getByRole("button", { name: "Technology" }).click();
  await page.getByRole("group", { name: "Mentorship preference" }).getByRole("button", { name: "I'd love a mentor" }).click();
  await shot(page, "wizard-goals");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "+ Product strategy" }).click();
  await page.getByRole("button", { name: "+ Fintech" }).click();
  await page.getByRole("button", { name: "+ AI", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Quirky intro").fill("Former pastry chef turned product nerd. I can rank every croissant in Philly.");
  await page.getByRole("button", { name: "+ Cooking" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("LinkedIn URL").fill("https://www.linkedin.com/in/jordan-rivera");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("group", { name: "Shared contact details" }).first().getByRole("button", { name: "LinkedIn" }).click();
  await shot(page, "wizard-privacy");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Preview" }).waitFor();
  await page.getByRole("article").waitFor();
  await shot(page, "wizard-preview");
  await page.getByRole("button", { name: "Finish profile" }).click();

  await page.getByText("Your match is revealed in").waitFor();
  await shot(page, "waiting-room");

  // Time passes: registration closes, the scheduler runs matching, then the reveal.
  await move("update events set registration_deadline = now() - interval '1 minute', starts_at = now() - interval '5 minutes' where slug = $1");
  console.log("scheduler", JSON.stringify((await scheduler()).results));
  await page.goto(`${BASE}/e/${slug}/match`);
  await page.getByText("Not quite yet").waitFor();
  await shot(page, "match-before-reveal");
  await move("update events set primary_reveal_at = now() - interval '10 seconds' where slug = $1");
  await scheduler();
  await page.reload();
  await page.getByRole("button", { name: "Reveal your match" }).waitFor();
  await shot(page, "match-envelope");
  await page.getByRole("button", { name: "Reveal your match" }).click();
  await page.getByText("Why we matched you").waitFor();
  await shot(page, "match-revealed");
  await page.getByRole("button", { name: /Stay in touch/ }).click();
  await page.getByText(/We'll let you know/).waitFor();

  // Organiser on desktop
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const op = await desk.newPage();
  op.on("pageerror", (e) => console.error("PAGE ERROR (organiser)", e.message));
  await op.goto(`${BASE}/auth`);
  await op.getByLabel("Email").fill("organiser@meetwise.test");
  await op.getByLabel("Password").fill("meetwise-demo-123");
  await op.getByRole("button", { name: "Sign in" }).click();
  await op.waitForURL(/\/events/);
  await op.goto(`${BASE}/organiser`);
  await op.getByRole("link", { name: /Penn Founders/ }).click();
  await op.getByText("Lifecycle").waitFor();
  await shot(op, "organiser-overview");
  await op.getByRole("tab", { name: "matching" }).click();
  await op.getByText("Weights").waitFor();
  await shot(op, "organiser-matching");
  await op.getByRole("button", { name: "Review", exact: true }).first().click();
  await op.getByText("Assignments").waitFor();
  await shot(op, "organiser-assignments");
  await op.keyboard.press("Escape");
  await op.getByRole("tab", { name: "attendees" }).click();
  await op.getByText(/Contact details are never visible/).waitFor();
  await shot(op, "organiser-attendees");
  await op.getByRole("tab", { name: "share" }).click();
  await op.getByAltText(/QR code/).waitFor();
  await shot(op, "organiser-qr");

  // Event ends; recommendations are generated and revealed.
  await move("update events set ends_at = now() - interval '1 minute', post_event_reveal_at = now() + interval '5 minutes' where slug = $1");
  await scheduler();
  await page.goto(`${BASE}/e/${slug}/discover`);
  await page.getByText("Five more people, soon").waitFor();
  await move("update events set post_event_reveal_at = now() - interval '5 seconds' where slug = $1");
  await scheduler();
  await page.reload();
  await page.getByText(/worth knowing|No recommendations/).waitFor();
  await shot(page, "discover");
  const connect = page.getByRole("button", { name: "Connect" }).first();
  if (await connect.count()) {
    await connect.click();
    await page.getByLabel("Add a note").fill("Would love to compare notes on fintech!");
    await page.getByRole("button", { name: "Send request" }).click();
    await page.getByRole("button", { name: "Requested" }).first().waitFor();
  }
  await page.goto(`${BASE}/notifications`);
  await page.getByRole("heading", { name: "Inbox" }).waitFor();
  await shot(page, "inbox");

  await op.getByRole("tab", { name: "analytics" }).click();
  await op.getByText("Attendee goals").waitFor();
  await shot(op, "organiser-analytics");

  // Admin
  const adm = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await adm.goto(`${BASE}/auth`);
  await adm.getByLabel("Email").fill("admin@meetwise.test");
  await adm.getByLabel("Password").fill("meetwise-demo-123");
  await adm.getByRole("button", { name: "Sign in" }).click();
  await adm.waitForURL(/\/events/);
  await adm.goto(`${BASE}/admin`);
  await adm.getByText("Members").waitFor();
  await adm.getByRole("tab", { name: "settings" }).click();
  await adm.getByText("Data retention (days)").waitFor();
  await shot(adm, "admin-settings");

  await browser.close();
  await db.end();
}

main().then(() => process.exit(0)).catch(async (e) => { console.error(e); process.exit(1); });
