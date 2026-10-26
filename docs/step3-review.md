# Step 3 — review of the build instructions

Checked the Notion page "Step 3 — Build the MVP & Publish" against the code that
actually exists in this repo (`server.js`, `public/index.html`,
`services/vision.js`, `scripts/evaluate.js`).

Two kinds of change below:

- **Part 1** — 3.3 rewritten without Firebase Authentication.
- **Part 2** — everything else in Step 3 that would break or confuse a student
  following it literally.

---

## Part 1 — Replace 3.3 (sign-in) with passcodes

### Why

The role distinction has to stay: Step 5 (report), Step 6 (video script) and
Step 7 (interview prep) all rely on the sentence *"exact locations only for
researchers, enforced on the server"*. That is one of the three key points and
it feeds the AI Ethics criterion.

But that sentence only needs **the server to decide what each viewer gets**. It
does not need Firebase Authentication. A shared passcode gives the same
server-side enforcement with roughly a fifth of the code, and removes the parts
most likely to fail in front of judges: Google sign-in popups, authorised
domains on the production URL, custom claims, and "you must sign out and in
again for your new role to work".

The four roles and their order stay exactly as the other steps describe them,
so **3.4 – 3.7 need no changes at all**.

### What the student does by hand first

Add to `.env` (invent three different passcodes; they are not secret in the
cryptographic sense, but keep them out of git and off the slides):

```txt
PASSCODE_CONTRIBUTOR=...
PASSCODE_RESEARCHER=...
PASSCODE_ADMIN=...
```

The same three go into Vercel's Environment Variables in 3.9.

### Replacement prompt for 3.3

```txt
The app now stores data in Firestore (services/firebase.js). Add roles.

We are deliberately NOT using Firebase Authentication. This is a school
prototype, and a shared passcode is enough to show that access control is
enforced on the server. Put a short comment in server.js saying this, and
saying that a real deployment would use one account per person.

Roles, in order: public < contributor < researcher < admin
- public: no passcode. Can view the map and the stats.
- contributor: can upload photos.
- researcher: can also see exact locations and photos, and verify AI tags.
- admin: everything a researcher can do, plus delete sightings.

Backend (server.js):
1. Read PASSCODE_CONTRIBUTOR, PASSCODE_RESEARCHER and PASSCODE_ADMIN from .env.
   At startup build a lookup from passcode string to role name, skipping any
   that are not set. If two are set to the same string, print a warning and
   keep the higher role. Never log a passcode value.
2. Add middleware on every /api/ route that sets req.user = { role, name }:
   - role comes from looking up the "x-passcode" request header. A missing or
     unknown passcode means role "public".
   - name comes from the "x-user-name" header, trimmed, cut to 40 characters,
     defaulting to "Anonymous".
3. Add requireRole(minRole) using the order above. On failure return status 403
   with { error: "This action needs the <minRole> passcode" }.
4. POST /api/upload requires contributor. Save uploaded_by_name on the sighting.
5. GET /api/photos/:id requires researcher.
6. DELETE /api/records/:id requires admin.
7. GET /api/records and GET /api/stats stay open to everyone for now. Location
   privacy is the next feature.
8. Add GET /api/me returning { role, name }, so the page can show the current
   role instead of guessing it.

Frontend (public/index.html):
9. Add an account area at the top of the sidebar: a "Your name" text box, a
   "Passcode" password box, a "Use passcode" button, and a line showing the
   current role. When a passcode is in use, show a "Sign out" button that
   clears it.
10. Keep the name and passcode in localStorage so a page reload keeps the role.
11. After "Use passcode", call GET /api/me and display the role it returns. If
    it comes back "public", show "That passcode was not recognised".
12. Write one helper, apiFetch(url, options), that adds the "x-passcode" and
    "x-user-name" headers, and use it for EVERY call to /api/ including the
    upload form, so that no call can forget the headers.
13. Show the upload form only when the role is contributor or higher.

Keep all text in English. List changed files and give me a test plan.
```

### Test (unchanged from the original 3.3)

| Action | No passcode | Contributor | Researcher | Admin |
| --- | --- | --- | --- | --- |
| See the map | ✅ | ✅ | ✅ | ✅ |
| See the upload form | ❌ | ✅ | ✅ | ✅ |
| See photos in popups | ❌ | ❌ | ✅ | ✅ |
| Delete a sighting | ❌ | ❌ | ❌ | ✅ |

- [ ] Every cell above behaves as shown
- [ ] A wrong passcode gives "That passcode was not recognised", not a crash
- [ ] Reloading the page keeps the role
- [ ] With no passcode, calling DELETE directly (e.g. from the browser console)
      returns 403 — the rule is on the server, not just hidden in the page

### Say this in the report

> A shared passcode is not real authentication: everyone with the researcher
> passcode is the same user to us, and we cannot revoke one person's access.
> We chose it so the prototype stayed small enough to build and explain. A real
> deployment would give each ranger their own account. What the passcode does
> demonstrate is the part that matters for privacy: the server, not the browser,
> decides which coordinates each viewer receives.

Judges reward a team that knows the limits of its own design.

---

## Part 2 — Other problems in Step 3

### A. Would produce a broken app

**A1. 3.4 renames the coordinate fields and breaks every marker.**
`public/index.html` draws markers from `rec.lat` / `rec.lng` (line 149) and
fits the map with `r.lat` / `r.lng` (line 169). The 3.4 prompt replaces those
with `precise_lat` / `public_lat` and only says "the map shows whatever the API
returns". Students will end up with an empty map and no error message.

Add to the 3.4 prompt:

```txt
6. GET /api/records must always return the position the viewer is allowed to
   see in fields named lat and lng, so the existing map code keeps working.
   For researchers and admins these hold the precise position; for everyone
   else they hold the public position. Keep precise_lat/precise_lng and
   public_lat/public_lng in Firestore, but do not send precise_lat/precise_lng
   to anyone below researcher.
```

**A2. 3.2 renames `imageUrl` to `photoUrl` without saying so.**
The record built in `server.js:95` uses `imageUrl`, and the popup reads
`rec.imageUrl` (`index.html:163`). The 3.2 prompt introduces `photoUrl`. Add to
step 4 of that prompt: *"Rename the existing imageUrl field to photoUrl, and
update public/index.html to match."*

**A3. 3.5 creates an ES module that the page cannot load.**
The prompt says `public/species-config.js` should **export** an object, but
`index.html` uses a plain `<script>` block, where `import` is a syntax error.
Add to the 3.5 prompt:

```txt
8. public/species-config.js must work with the existing plain <script> tags:
   assign the config to window.SPECIES_CONFIG rather than using export, and
   load it with <script src="species-config.js"></script> before the main
   script. Do not convert index.html to type="module".
```

**A4. 3.7's 30-second refresh makes the map jump.**
`loadRecords()` calls `map.fitBounds(...)` every time it runs
(`index.html:168`). Polling it every 30 seconds will yank the map back to the
full extent while someone is panning or zooming — including during the demo.
Add to the 3.7 prompt:

```txt
6. Only fit the map to the markers on the first load. The 30-second refresh
   must redraw the markers without changing the current map position or zoom,
   and must not close an open popup.
```

### B. Works locally, fails once deployed

**B1. The upload can exceed Vercel's function time limit.**
`fetchWithRetry` in `services/vision.js` retries 429 and 503 up to 6 times with
5s, 10s, 15s, 20s, 25s, 30s backoff — up to about 105 seconds of waiting. The
free Gemini tier is 15 requests/minute, so a 429 during a live demo is
realistic. Vercel will kill the function first and return 504.

That retry budget is right for `scripts/evaluate.js`, which runs 123 images
unattended, and wrong for a web request. Add to the 3.8 prompt:

```txt
8. services/vision.js retries rate-limited Gemini calls up to 6 times, which
   can take over 100 seconds. That is correct for scripts/evaluate.js but too
   slow for a web request. Make the retry count a parameter that defaults to 6,
   and have server.js pass 2, so a rate-limited upload fails in a few seconds
   with the message "The AI service is busy. Please try again in a moment."
9. Add a vercel.json setting the function's maxDuration to 60 seconds, and
   check Vercel's current Hobby-plan limit when you deploy.
```

**B2. `sharp` is a native module.**
It ships different binaries per platform. Installing on a Mac and deploying to
Vercel's Linux runtime is a well-known source of "Could not load the sharp
module using the linux-x64 runtime". If that appears in the Vercel logs, the
fix is to let Vercel install it itself (do not commit `node_modules`) and, if
needed, `npm install --os=linux --cpu=x64 sharp` before committing the
lockfile. Worth one warning line in 3.2 so nobody loses an evening to it.

**B3. The 3.9 environment variable list is missing the passcodes.**
It should now be: `GEMINI_API_KEY`, `VISION_MODEL`, `PROMPT_VARIANT`,
`FUZZ_KM`, `FIREBASE_SERVICE_ACCOUNT`, `PASSCODE_CONTRIBUTOR`,
`PASSCODE_RESEARCHER`, `PASSCODE_ADMIN`.

With the passcode version of 3.3, step 7 of 3.9 (adding the production domain
to Firebase's authorised domains) can be deleted — there is no Firebase sign-in
any more.

**B4. If the Express preset is not detected**, add a `vercel.json` that routes
everything to `server.js`. Worth a sentence so a student who does not see
"Express" in the Framework Preset dropdown does not stall.

### C. Facts to correct

**C1. The 700 KB rule in 3.2 needs to say *base64*.**
Firestore's limit is ~1,048,576 bytes **per document**, and base64 makes a file
about 33% larger. Measured on this repo's test set:

| | size |
| --- | --- |
| smallest test image | 184 KB |
| median | 627 KB |
| largest (`human_day_08.jpg`) | 1029 KB |

The largest image becomes about 1.37 MB as base64 — **over the limit**. So the
resize step in 3.2 is genuinely required, not optional. But the prompt should
say: *"the base64 string must stay under 700 KB"*, not "if it is still over
700 KB", which students will read as the JPEG size.

**C2. 3.1's "Production mode" needs one reassuring sentence.**
Production mode denies all direct client access to Firestore. That is correct
here, because every read and write goes through our Express server with the
service account. Without that sentence a student will think they chose the
wrong option.

**C3. The phone test in 3.9 may fail on an iPhone.**
`index.html:86` accepts only `image/jpeg,image/png,image/webp`, and `server.js`
filters on the same list. iPhones can produce HEIC. Safari usually converts to
JPEG on upload, but not always. Add to the test: *"if the phone upload is
rejected, set the camera to Settings → Camera → Formats → Most Compatible and
try again."*

### D. Smaller suggestions

- **Take `results/` out of `.gitignore`.** The evaluation reports are the
  evidence for the report and the interview. They belong in the repo.
- **`multer@1.4.5-lts.1` has published denial-of-service advisories.** `npm
  audit` will flag it. Upgrading to multer 2.x is a small change and avoids an
  awkward answer if a judge asks about security.
- **Firestore is in europe-west2 (London); Vercel Hobby defaults to a US
  region.** Every Firestore call then crosses the Atlantic. Not worth
  restructuring, but set the Vercel project region to London if the option is
  available.
- The old `blur()` function and the "Public view" checkbox are removed in 3.4 —
  correct, because they let the *browser* decide what to hide, which is exactly
  what the privacy argument says you must not do. Worth saying out loud in the
  report, since it shows the team understood why the first version was wrong.

---

## Part 3 — Second pass: following the page as a student

The first pass asked "would the code break?". This pass asked "would a student
get stuck?". Seven things, all now fixed on the Notion page.

1. **The rollback instruction did not work.** The page said to undo a bad
   change with `git checkout .`. That restores files that already existed, but
   the assistant *creates* files (`services/firebase.js`,
   `public/species-config.js`, the one-off scripts), and `git checkout .`
   leaves every one of them in place — so the app stays half-changed and the
   student thinks the undo failed. Now `git restore .` **and** `git clean -fd`,
   with a note that `.env` and `serviceAccount.json` survive because git
   ignores them and `git clean -fd` skips ignored files.

2. **No test could have passed as written: the test images have no GPS.**
   Public camera-trap datasets strip it for privacy. Checked with `exifr` —
   `exifr.gps()` returns nothing for them. Every "upload a photo" test would
   have produced "This photo has no GPS data" and looked like a bug in the
   feature just built. Added one callout near the top with coordinates to type
   (-2.33 / 34.83) and a reminder to vary them between uploads.

3. **The team could not all run the app.** 3.1 has one person generate
   `serviceAccount.json` and says never to share it — with no instruction for
   anybody else, who each need one locally. Added: once added to the Firebase
   project, every member generates their own key. A project can hold many, so
   the secret never travels.

4. **`sharp` was never installed.** The 3.2 prompt said "install
   firebase-admin" and then used sharp without mentioning it.

5. **The "DELETE returns 403" test had no instructions.** A student cannot run
   it without being shown how. Added the one-line `fetch(...)` snippet and how
   to get a sighting id — and it is a good thing to show the judges, since it
   proves the check is on the server rather than in the page.

6. **The 3.4 privacy test was not observable.** "Markers sit at the exact
   positions" — a 5 km shift is invisible at the default zoom. Now says to zoom
   in on one sighting or compare the `lat` values in `/api/records`.

7. **A stale instruction** about replacing `<paste … here>` placeholders, which
   no longer exist now that the Firebase web config is gone.
