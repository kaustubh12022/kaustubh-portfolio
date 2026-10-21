# Asset capture guide

**Goal:** Real screenshots and short recordings for the five portfolio projects. No stock images, no mock dashboards, no fabricated "after" screenshots. Every asset gets a caption, alt text, capture date, and project ID.

---

## 1. Tools (all free)

| Tool | Use |
|---|---|
| **Playwright** | Scripted desktop/mobile screenshots at exact viewports. Already a dev dependency. |
| **OBS Studio** | 45–90 s screen recordings with a clean browser window. |
| **Windows Snipping Tool** (`Win + Shift + S`) | Quick manual captures while developing. |
| **Chrome DevTools** | Mobile viewport emulation (`Ctrl + Shift + M`) and device pixel ratio. |
| **HandBrake** (optional) | Compress `.mp4` files before committing. |

**Standard sizes**
- Desktop: `1600 × 1000`, device scale factor `2` (output 3200 × 2000).
- Mobile: `390 × 844`, device scale factor `3`.
- Video: `1920 × 1080`, 30 fps, H.264 MP4, under 12 MB.

**Naming**
```
public/media/<project>/<view>.png
public/media/<project>/<view>-mobile.png
public/media/<project>/<flow>.mp4
```
Examples: `public/media/pawna/booking-flow.png`, `public/media/c54/scoreboard-mobile.png`.

**Privacy rules**
- Use seeded demo data: `Player 1`, `Test Guest`, `demo@example.com`.
- Never capture real guest names, phone numbers, emails, order IDs, or payment data.
- If a real name appears, blur it before saving. Do not rely on CSS blur in DevTools.
- Do not show API keys, Supabase URLs with tokens, or `.env` contents.

---

## 2. Playwright capture script

Create `scripts/capture/screenshots.ts` when Phase 6 starts. The core pattern:

```ts
import { chromium, devices } from "@playwright/test";

const browser = await chromium.launch();

// Desktop
const desktop = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await desktop.newPage();
await page.goto("https://pawna-camping.vercel.app", { waitUntil: "networkidle" });
await page.screenshot({
  path: "public/media/pawna/booking-flow.png",
  fullPage: false,
});

// Mobile
const mobile = await browser.newContext({ ...devices["iPhone 13"] });
const mobilePage = await mobile.newPage();
await mobilePage.goto("https://c54-casino.vercel.app", { waitUntil: "networkidle" });
await mobilePage.screenshot({
  path: "public/media/c54/scoreboard-mobile.png",
  fullPage: false,
});

await browser.close();
```

Run with:
```powershell
npx tsx scripts/capture/screenshots.ts
```

If a page needs a login, do not hardcode credentials. Use a local seeded database or a temporary test account, and keep credentials in `.env.local`.

---

## 3. Per-project capture checklist

### SmartApply — already has verified screenshots

**Existing (ready):**
- `JobHunt-Automation/test_screenshots/4_tracker_view_verified.png` → `dashboard-tracker.png`
- `2_scanning_view_verified.png` → `dashboard-scanning.png`
- `5_tracker_mobile_verified.png` → `dashboard-mobile.png`
- `6_cards_and_badges_verified.png` → `job-cards.png`

**Add a 45–60 s recording:**
1. Start the app locally: `python app.py` (Flask API) and `npm run dev` in `frontend/`.
2. Load demo data; do not use a real recruiter inbox.
3. Record: idle → scan → shortlist → open a tailored PDF → tracker.
4. Save as `public/media/smartapply/pipeline.mp4`; compress if over 12 MB.
5. Add a caption: "Recorded walkthrough with synthetic job data (2026)."

**Do not** show a real email address, a real resume PDF, or the Supabase service key.

---

### Pawna Camping — needs UI captures

**Public booking flow (no login):**
1. Open `https://pawna-camping.vercel.app`.
2. Pick a property → dates → guests → package.
3. Capture the availability + price summary before submitting.
4. Capture the confirmation state with a test booking only if you can delete it afterwards. Otherwise stop before submit.

**Owner dashboard (login required):**
1. Run the stack locally against a seeded MongoDB (preferred), or use a test owner account.
2. Seed one property and two demo bookings.
3. Capture: bookings list, blocked dates, revenue card.
4. Blur guest names and phone numbers.

**Mobile:** repeat the booking flow at `390 × 844`.

**Save:**
```
public/media/pawna/booking-flow.png
public/media/pawna/booking-flow-mobile.png
public/media/pawna/owner-dashboard.png
```

**Do not** capture the public properties response that includes the owner email, and do not show `plainPassword`.

---

### C54 — needs UI captures

1. Open `https://c54-casino.vercel.app`.
2. Create a session with four demo players: `Player 1` … `Player 4`.
3. Enter two rounds with simple scores.
4. Capture the host score-entry screen and the live scoreboard.
5. Open the settlement view; capture the transfer list.
6. Capture mobile at `390 × 844`.
7. Record a 30–45 s clip: add round → scoreboard updates → settle.

**Save:**
```
public/media/c54/score-entry.png
public/media/c54/scoreboard.png
public/media/c54/scoreboard-mobile.png
public/media/c54/settlement.mp4
```

**Before capturing:** rotate the Supabase credentials and tighten RLS. Do not show the old hardcoded key or the project URL with a token.

---

### Personal AI OS — needs in-app captures

1. Run `flutter run -d chrome` from `personal-ai-os/`.
2. Use a test Supabase user with seeded tasks and expenses.
3. Capture:
   - Chat with an inline chart (expense summary).
   - Task list after a chat-created task.
   - Budget screen.
4. Capture one "before/after" of a chat command creating a task, but label it as a demo.
5. Save:
```
public/media/personal-ai-os/chat.png
public/media/personal-ai-os/tasks.png
public/media/personal-ai-os/budget.png
```

**Do not** show real financial data or a real email address. If RLS is still off, use a local Supabase instance.

---

### Aura — live capture with permission

1. Open `https://aura-skincare-voice-cx.onrender.com` in Chrome.
2. Use a headset; grant microphone permission.
3. Say a scripted line: "I need to check the status of order AURA-1042."
4. Let the agent call the order tool; capture the tool result card.
5. Interrupt the agent mid-sentence to demonstrate barge-in.
6. End the call; capture the summary.
7. Record with OBS at 1080p, 30 fps, 45–75 s. Keep the clip under 12 MB.

**Save:**
```
public/media/aura/live-call.mp4
public/media/aura/order-tool.png
public/media/aura/summary.png
```

**Consent:** Aura was built as a hiring assessment. Confirm the client permits publication; the portfolio labels it "Hiring assessment — published with permission." Do not show a real customer name or order.

---

### DayScore — optional

Open `https://day-score-three.vercel.app`, create a demo day, capture the score ring and history at desktop and mobile. Save under `public/media/dayscore/`. Only include it if the visual is strong; it is not a flagship.

---

## 4. Animated explainers ("video-style" answers)

The portfolio's animated explainers are React/SVG components, not stock video:

- **Architecture walkthrough:** nodes appear in sequence, edges draw, labels fade in.
- **Flow diagram:** a request travels through the pipeline with a moving dot.
- **Code reveal:** a file opens line-by-line with a highlight on the cited range.

These run in the browser and respect `prefers-reduced-motion`. For LinkedIn, record the component playing in Chrome with OBS and export an MP4; do not generate a synthetic video that implies a product recording.

**Recording a UI explainer**
1. Open the portfolio in Chrome at 1600 × 1000.
2. Trigger the visual, then start OBS.
3. Wait one full loop (8–12 s), then stop.
4. Trim the start/end; export H.264; keep under 12 MB.

---

## 5. Register the asset

After saving a file:
1. Add it to `content/projects/<project>.yaml` under `assets` with `kind`, `alt`, `caption`, and `status: ready`.
2. Add a matching entry to `content/assets.yaml` with the original source path and capture date.
3. Run `npm run typecheck` — the Zod schema rejects missing fields.
4. Optimize: PNG for UI, WebP for photos, MP4 (H.264) for video. Do not commit files over 12 MB.

---

## 6. What not to capture

- No fabricated dashboards or fake customer logos.
- No stock photos labelled as product screenshots.
- No "before/after" images that imply a metric without a source.
- No real recruiter inbox, resume, phone number, or payment data.
- No terminal showing secrets.
