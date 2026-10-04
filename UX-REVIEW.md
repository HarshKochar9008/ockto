# PaperTrail UX review: conversion pass

Reviewed 2026-10-04 against the running app (Vite on :5173, real API, real worker, local Gemma). A fresh account signed up, created a workspace, uploaded `demo/northbridge-requirements.pdf` and `demo/transcript-alex-rivera.pdf`, then opened every screen at 1440px and 390px.

## Status (2026-10-04)

Implemented: C1–C3 and C5, H1–H8, and N1–N7. C4 is partly done: the **first** analysis now starts by itself in the web app. Later re-runs after new documents finish are still a click on "Run the analysis again". To make those automatic, start them from the end of the processDocument workflow.

On top of the review, the UI was redesigned:
- The Flywheel design language from `D:\devotion-badges`: sky gradient, starfield, warm paper cards, Fraunces and Inter.
- A new brace mark whose middle piece rotates.
- A bento dashboard with an icon rail.

## Before implementing

- **There's no pricing or trial.** Here, "conversion" means a visitor creates an account and reaches their first evidence-backed checklist item. Findings are ranked by how many people each one loses along that path.
- **Keep the hackathon demo working.** Judges see Temporal retries through the failure-injection toggles, the Activity timeline and the Temporal/Sentry links. Move them out of the applicant's way, but don't delete them. `DEMO_FAILURE_INJECTION` still decides whether they exist.
- **Mobile isn't broken.** No screen scrolls sideways at 390px. The phone findings below are about order and content that can't be seen, not about broken layout.
- Leave alone what's listed under **Don't change** at the bottom.
- Run `npm run typecheck` and `npm test` after each section. `nextActions` is exported from `server/service.ts`. If its signature changes, update its callers and tests.

## Verdict

The app is competent, accessible and forgettable. The engineering is honest. The product makes a nervous applicant watch a spinner for more than 6 minutes, tells them to do the thing they just did, and offers them a checkbox to break the app on purpose. No first-time visitor reaches the checklist.

| Funnel step | What happened |
|---|---|
| Land | The form says "Sign in to PaperTrail". On a phone, the first form field is 1.6 screens down. |
| Sign up | 3 fields, then 0.3 s to an empty dashboard |
| Create workspace | A 5-field modal, then an Overview with 6 cards and 3 filled primary buttons |
| Upload requirements | "Uploaded, processing started" |
| Wait | **Still "Processing" with 0 drafts after 6 min 24 s.** The UI promised "a minute or two". |
| Confirm, upload evidence, click Run analysis, wait again | Never reached. The README estimates 1–2 min per requirement on CPU. |

## First-time user log (pass 2)

The tester played a student applying for an MSc. Steps marked **LEAVE** are where they wanted to quit.

1. **Landing.** "OK, I get it. Where's the button? There's only a sign-in box, and I don't have an account. Oh, there's a small 'Create account' tab." On the phone they scrolled past three cards, an example and a disclaimer before reaching any form.
2. **Signup** asks for their name. Fine.
3. **Dashboard.** Three boxes say they have nothing. Two identical "New workspace" buttons.
4. **New workspace modal.** "Type: Insurance claim? I thought this was for university applications." They picked Scholarship.
5. **Overview.** Six boxes. An "Add requirements" button, a big green "Run analysis" button, and a yellow box asking if they want to "simulate a transient failure". "Is this thing broken?" **LEAVE**
6. **Requirements, after upload.** "It says processing and that drafts appear below. Below, it says 'Upload the requirements document'. I just did."
7. **Back to Overview.** "What to do next: Add the requirements. I DID." **LEAVE**
8. **Waited 6+ minutes.** No progress and no estimate. "Recent workflow runs: Process document, Running." "What does that mean?" Nothing will bring them back if they close the tab. **LEAVE**
9. **Assistant.** "'Why is my English test marked for review?' I haven't uploaded an English test."
10. **Report.** Eight boxes, all showing 0.
11. **Settings.** "AI endpoint http://localhost:11434/v1? 'Demo failure switch: On'? Is my passport going into some demo?"

Tags: **[Design]** comes from the designer pass, **[User]** from the first-time user pass.

---

## Critical

### C1. The landing page asks strangers to sign in [Design]
- **Where:** `web/src/pages/Landing.tsx:21` (MODES order), `:25` (`useState('login')`), `:70-82` (auth card)
- **Problem:** Every first visit sees "Sign in to PaperTrail". Returning users already have a session cookie and are redirected, so they rarely see this page. The hero has no call to action. On a 390×844 phone, the form starts 1325px down, after the step cards, the example checklist and a disclaimer.
- **Fix:**
  1. Default `mode` to `'signup'` and swap the MODES order so "Create account" comes first.
  2. Add a primary button under the hero paragraph, "Check my application, free", that scrolls to the auth card and focuses its first input. It must be visible without scrolling on a phone.
  3. Change the submit label in signup mode from "Create account" to "Start my checklist".
- **Done when:** at 390×844, a primary button is visible without scrolling, and a signed-out visitor sees the signup form by default.

### C2. After the requirements are uploaded, the app asks for them again [User]
- **Where:** `server/service.ts:237-238` (`if (!reqs.length)` adds `add_requirements`), `:243` (upload is only suggested after confirmation); `web/src/pages/Requirements.tsx:40-42` (empty state)
- **Problem:** While the requirements PDF is processing:
  - "What to do next" on Overview still says "Add the requirements. Upload the requirements PDF".
  - On the Requirements tab, the empty state directly under the "Processing" row says "Upload the requirements document, paste the text…".

  This is where people decide the product is broken.
- **Fix:**
  1. In `getWorkspace`, also count requirements-role documents that are `queued` or `processing`, and pass that count to `nextActions`.
  2. In `nextActions`, when there are no requirements but a source is processing, return this action instead of `add_requirements`: `{ kind: 'upload', title: 'While we read your requirements, add your documents', detail: 'Reading <filename>. Drafts appear on the Requirements tab when it finishes. Upload your transcript, passport, CV and letters now so they're ready.' }`. The `upload` kind already routes to Documents (`Overview.tsx:82`).
  3. Drop the `confirmed.length &&` precondition on the upload action (`service.ts:243`). Evidence processing doesn't depend on requirements, so both can run at once and the user works through the wait.
  4. In the Requirements empty state, when any requirements source is processing, say "Extracting requirements from <filename>. Drafts will appear here." instead of asking for an upload.
- **Done when:** a requirements PDF uploaded to a new workspace never shows "Add the requirements" while it processes, and the first next action points to Documents.

### C3. Waits of several minutes show a bare spinner, and the time estimate is wrong [User]
- **Where:**
  - `web/src/pages/Requirements.tsx:79` ("drafts appear below") and `:99` ("Drafts appear below in a minute or two")
  - `web/src/ui.tsx:268-272` (`DocStatusBadge`)
  - Observed: still processing after 6 min 24 s, with 0 drafts. The README says extraction takes about 5 min on CPU, plus about 3 min to load the model on first use.
- **Problem:** The first useful result is 5–10+ minutes away, but the UI promises "a minute or two". Nothing gives a time range, says it's safe to leave, or brings the user back.
- **Fix:**
  1. `Thinking` in `web/src/pages/Assistant.tsx:84` already shows elapsed seconds. Move it to `ui.tsx` as `Elapsed({ since })` and show it next to every document that's queued or processing, measured from `created_at`. Copy: "Reading… 2:14 elapsed. Usually 3–8 minutes on a local model."
  2. Replace "in a minute or two" with that same range, and keep the range in one constant.
  3. Add: "You can close this tab. Processing continues on the server." This is true: the work runs in Temporal workflows.
  4. Later, not now: send a notification when processing finishes, through the existing reminder webhook.
- **Done when:** every processing state shows elapsed time and the expected range.

### C4. The analysis never starts on its own [User]
- **Where:** `server/service.ts:431` (`confirmRequirements`), `:444` (`analyze`); `server/app.ts:154` (confirm route); `web/src/pages/Overview.tsx:127-142`
- **Problem:** Getting to the first checklist takes: upload, wait, confirm, upload, wait, **click Run analysis**, wait. The click is pure friction, because `nextActions` already knows when the analysis can run. Users who left during the second wait come back to a checklist where every item says "Not assessed".
- **Fix:**
  1. In the confirm route, after `confirmRequirements`, call `svc.analyze` if any evidence document is ready. Ignore its 409 responses.
  2. When an evidence document finishes processing, the workspace has confirmed requirements, and no analysis is running, start `analyzeWorkspace`. Do this from the end of the processDocument workflow through an activity. That activity needs a version of `analyze()` without the `userId` ownership check, since the call is internal to the server.
  3. A document that finishes during a run leaves `stale_analysis` true, and the existing "Run the analysis" next action covers that case. Keep the Run analysis button for re-runs only.
- **Done when:** confirming with a processed transcript starts the analysis without a click, and a document uploaded after confirmation starts the analysis when it finishes.

### C5. A "simulate a transient failure" checkbox sits next to the primary button [Design + User]
- **Where:**
  - `FailureToggle` (`web/src/ui.tsx:210-226`), rendered at:
    - `Overview.tsx:137` (the Analysis card)
    - `Documents.tsx:96` (the upload zone on both Requirements and Documents)
    - `Tasks.tsx:187`
  - `Tasks.tsx:161` ("In 1 minute (handy for demos)")
  - `Settings.tsx:11-21` and `:47`: the Integrations card shows a localhost AI endpoint, model names, a Temporal UI link and "Demo failure switch: On"
  - `Overview.tsx:53` ("Recent workflow runs" card)
  - `Assistant.tsx:64` (shows the model name)
  - `.env.example` sets `DEMO_FAILURE_INJECTION=true` by default
- **Problem:**
  - The first screen after creating a workspace shows a dashed amber box asking an applicant whether they want to break the app.
  - The upload screen offers a dropdown of internal processing steps.
  - Settings shows a localhost URL to someone deciding whether to trust you with their passport.

  The whole product reads as a prototype.
- **Fix** (the judge demo keeps working):
  1. Wrap the output of `FailureToggle` in `<details><summary>Developer options</summary>…</details>` with neutral stone styling instead of amber. This one change covers all four places it's rendered.
  2. In Settings, collapse the Integrations card into a `<details>` titled "System status", and put Privacy first (see H7).
  3. Delete the "Recent workflow runs" card from Overview, since Activity already shows it. Show the "In 1 minute" reminder preset only when `demo_failure_injection` is on, and remove "(handy for demos)" from its label.
  4. Change the Assistant footer to "Answers can be wrong. Check them against the cited sources." without the model name.
- **Done when:** with the flag on, no amber box or infrastructure term is visible on Overview, Requirements or Documents until "Developer options" is expanded.

---

## High impact

### H1. A new user goes from an empty dashboard to a 5-field modal to the wrong tab [User]
- **Where:** `web/src/pages/Dashboard.tsx:29-31`, `:66`, `:126-144` (`NewWorkspace`, which navigates to `/w/${id}` at `:129`)
- **Problem:** After signup, the dashboard shows three side cards with nothing in them. "All documents are processed." appears with zero documents. There are two identical "New workspace" buttons. Next comes a modal with Name, Type, Institution, Deadline and Notes. It lands on Overview, whose only useful button leads to Requirements.
- **Fix:**
  1. When `d.workspaces.length === 0`, render `<NewWorkspace />` inline in a card titled "Start your first application" instead of the EmptyState and modal, and hide the three side cards.
  2. Cut the form to Name, Deadline and an optional Institution. Remove Type (see H2) and Notes; no screen lets the user edit either one afterwards.
  3. Give Deadline the hint "We flag documents that expire before it."
  4. In `onSuccess`, navigate to `/w/${ws.id}/requirements`.
- **Done when:** after signup, one screen leads straight to the requirements upload.

### H2. The workspace type has no effect, and two of the options aren't supported [User]
- **Where:** `web/src/pages/Dashboard.tsx:134` (Type select); `web/src/labels.ts:10` (`PROCESSES`); `process_type` is only stored and shown as a subtitle
- **Problem:** Choosing "Scholarship" changed only a grey subtitle. "Job application" and "Insurance claim" are offered, but the landing page, document classes (transcript, language certificate, passport…) and copy are all about university applications.
- **Fix:** Remove the Type select from the create form. The schema already defaults to `university_application` (`shared/schemas.ts:68`), and the enum stays for stored data. If Type comes back later, it has to change copy, suggestions or document classes; otherwise it shouldn't be offered.
- **Done when:** the create form has no Type field, and nothing in the UI implies support for job or insurance applications.

### H3. Overview shows six cards and three primary buttons for one real action [Design]
- **Where:** `web/src/pages/Overview.tsx:18-69` (layout), `:109`, `:134`, `:172-174`. On a phone, an empty workspace's Overview is 1547px tall.
- **Problem:** An empty workspace shows six cards: What to do next, Analysis, Progress, Checklist, Open tasks and Recent workflow runs. Three filled teal buttons compete: Add requirements, Run analysis and Go to requirements, so there's no obvious place to look. "Run analysis" is primary and enabled even though it can only fail. The server returns 409 "Confirm at least one requirement before running the analysis."
- **Fix:**
  1. Until at least one requirement is confirmed, render only "What to do next", full width.
  2. In `AnalyzeButton`, use the `secondary` variant and disable it unless `ws.next_actions` contains `analyze` or there are confirmed requirements and ready evidence. The first next-action button stays the only primary button (`:109`).
  3. In the Checklist card, don't render the "Confirm N drafts" or "Go to requirements" button when "What to do next" already offers that action.
- **Done when:** an empty workspace's Overview is one card with one primary button and is shorter than 900px on a phone.

### H4. On day one, 4 of the 7 tabs are empty, and on a phone 3 are off-screen [Design + User]
- **Where:** `web/src/pages/Workspace.tsx:19` (`TABS`)
- **Problem:** Assistant, Tasks, Activity and Report have nothing to show for the first 10+ minutes; Report shows eight tiles reading 0. At 390px the tab bar scrolls sideways with nothing to show it can scroll: "Assistant" is cut off, and Tasks, Activity and Report can't be seen.
- **Fix:**
  1. Show Assistant only when `ws.counts.documents > 0`, and Report only when `ws.counts.requirements > 0`.
  2. Take Activity out of the tab bar. Link to it as "Processing history" at the bottom of Overview and Documents. Judges can still reach it, and it's a page for operators.
- **Done when:** a new workspace shows at most 4 tabs, all visible at 390px.

### H5. The Assistant suggests questions about documents the user doesn't have [User]
- **Where:** `web/src/pages/Assistant.tsx:11` (fixed `SUGGESTIONS`, including "Why is my English test marked for review?")
- **Problem:** Everyone gets the suggestions written for the demo data, and they can be clicked in an empty workspace. Each click starts a 30–90 s local model call that can only answer "insufficient evidence".
- **Fix:**
  1. While no document is ready, replace the chat with an EmptyState: "Upload documents first, then ask anything about them", with a link to Documents.
  2. Build suggestions from `useRequirements`:
     - the first `needs_review` item: `Why is "<title>" marked for review?`
     - any `missing` item: "Which documents are still missing?"
     - a deadline set: "Which documents expire before my deadline?"
- **Done when:** no suggestion mentions anything that isn't in the workspace.

### H6. The landing page describes the main feature but never shows it [Design]
- **Where:** `web/src/pages/Landing.tsx:8` (`STEPS`), `:42` (three numbered cards), `:15` and `:52` (example checklist)
- **Problem:** What sets PaperTrail apart is that every status links to the exact passage in the user's own document. The page describes this in a paragraph, then shows three rows of badges that could belong to any to-do app. Numbered how-it-works steps in cards are the most generic section a SaaS page can have.
- **Fix:** Replace the three step cards with one example built from existing components, no image needed:
  1. The requirement row "IELTS Academic 6.5 overall", badged Needs review.
  2. Below it, the quoted passage in a `<mark>`, captioned "aet-score-report.pdf, page 1".
  3. The reason: "Expires 12 Dec 2026, before your 15 Jan 2027 deadline."

  That one card makes the case for the product. If the steps stay at all, reduce them to one line of small text.
- **Done when:** the desktop view without scrolling shows a highlighted passage tied to a status.

### H7. Privacy is the biggest objection, and the answer is only in Settings [Design]
- **Where:** `web/src/pages/Settings.tsx:59` (Privacy card); nothing on Landing
- **Problem:** The app asks for passports and transcripts, but its reassurance is only visible after signup, below a localhost URL.
- **Fix:** Put one line under the landing call to action and inside the signup card: "Delete a document and its file, text and search index go with it. Nothing counts as verified until you check it." Both statements are always true. Only add "processed on your own server" for deployments where `AI_BASE_URL` is local. `/system` needs a signed-in user, so either write that part of the copy for each deployment or add a public flag.

### H8. Each upload shows two rows with conflicting status [Design]
- **Where:** `web/src/pages/Documents.tsx:97` (the `UploadZone` results list) and `web/src/pages/Requirements.tsx:70-86` (Sources)
- **Problem:** On the Requirements tab, the same file appears twice. One row says "Uploaded, processing started" with a green outline that looks finished; the other says "Processing" with a spinner.
- **Fix:** When `fixedRole === 'requirements'`, show only the `failed` and `duplicate` rows from the results list, because Sources already shows live status.

---

## Nice to have

- **N1. The landing page depends on the API.** `web/src/main.tsx:32` shows "Something went wrong" instead of the pitch when `/auth/me` fails with a 5xx or a network error. In that case, render `<Landing />` anyway and show the error inside the auth card. Time to the heading was 13 s on the cold Vite dev server, so measure the production build separately; its single 100 KB gzipped bundle is fine.
- **N2. An empty status line.** `Dashboard.tsx:66` says "All documents are processed." when there are no documents. Hide the card or the line when there are none.
- **N3. Segmented control wrapping on phones.** On the Requirements tab at 390px, the control (`Requirements.tsx:51`) wraps 2+1 and leaves "Add one manually" alone on the second row. Shorten the labels to "Upload", "Paste" and "Type it".
- **N4. Every section looks the same.** Each one is the same white `rounded-lg border shadow-sm` card on stone-100 (`ui.tsx:51-63`), so nothing stands out. Give only the main action card a shadow or teal border, and flatten the rest. The app also uses only the system font (`index.css:3`, because the CSP blocks other origins). Host one variable font under `web/public`, which `'self'` allows.
- **N5. The user's name looks like a disabled link.** `main.tsx:70` shows it as grey text beside the nav links. Make it the Settings link, or remove it.
- **N6. The landing disclaimer reads like fine print.** The "AI assessments are suggestions, not decisions…" notice (`Landing.tsx:64`) could become a benefit: "You stay in control: nothing is marked verified until you check it."
- **N7. Signup asks for a name the app barely uses.** Drop the field (`Landing.tsx:74`). Make `SignupInput.name` optional (`shared/schemas.ts:61`) and default it to the part of the email before the @ in `signup`.

---

## Don't change

- Citations at passage level, with highlighting and a jump to the page (`DocumentView.tsx`). This is the best part of the app.
- The badge distinction: an outlined "Evidence found (AI)" versus a solid "Verified" (`ui.tsx:254-266`).
- The native `<dialog>`, skip link, focus-visible rings, labelled fields and `aria-live` regions.
- The inline two-step delete (`ConfirmDelete`), with no `window.confirm`.
- Layout at 390px. No screen scrolls sideways.

## Suggested order

1. C2 and C3 together (same files)
2. C1
3. C5
4. C4
5. H1–H5
6. Everything else
