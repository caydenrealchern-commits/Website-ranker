# Instant Lead Capture Audit

Enter a website address, get a scored audit of how well that site captures
inbound leads. Static page plus one serverless function. No database, no auth,
no paid API.

Built from `Instant Lead Capture Audit — Design Spec` (2026-08-28).

## Run it

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:8888. The dev server is plain Node with no
dependencies and no global CLI — it serves `public/` and routes
`POST /.netlify/functions/audit` to the same handler Netlify runs in
production. `npm run dev:netlify` still uses `netlify dev` if you have the CLI.

Audit a real site from the terminal:

```bash
npm run audit -- yourbusiness.co.uk
```

Run the tests:

```bash
npm test
```

## How it is laid out

```
public/index.html            front end, one file
netlify/functions/audit.js   the endpoint (rate limit, CORS, unlock, logging)
dev-server.js                local server, zero dependencies (applies _headers)
scripts/build.js             stamps the site URL, generates _headers + robots
src/
  ratelimit.js   three-layer limiter, shared store optional
  config.js      weights, vendor lists, bands, copy, brand   <- tune here
  fetcher.js     normalise, validate, SSRF guard, fetch with deadline
  extract.js     one document view: DOM + structured data + embedded state
  confidence.js  section 5 - can we trust a negative finding?
  checks.js      the 14 checks
  score.js       applies the section 5 rule, then scores
  audit.js       orchestrator, response shape
test/
  run-tests.js   fixture tests + the invariants
  cli.js         audit real sites from the terminal
  fixtures/      nine hand-written pages spanning the range
```

## Section 5: how failures are handled

This is the part that decides whether anyone believes the output, so it is
worth reading before changing anything.

### The problem

A plain fetch of a client-rendered site returns an empty shell. Run the checks
over it naively and all fourteen fail, so the tool tells an owner their site
has no phone number when the number is right there on the page. One report
like that and nothing else the tool says is believed.

### The rule

Findings are not equally trustworthy in both directions:

| Finding | Trustworthy? |
|---|---|
| We found a `tel:` link | Always. How the page renders cannot un-find it. |
| We did not find a `tel:` link | Only if we are confident we saw the real page. |

So confidence is **not a global switch that turns the report off**. It is a
qualifier on negative findings only:

- a **pass** stands at any confidence level;
- a **failure** on a render-sensitive check needs high confidence to be stated;
- otherwise it becomes **unknown** — shown as unverified, never as a fault, and
  excluded from the score's denominator.

`src/score.js` is the only place allowed to make that downgrade, which is what
makes it testable in one assertion instead of fourteen.

### Scoring under partial verification

The score is `earned / verifiable`, not `earned / 100`, and the report always
says how many points could not be checked. Below 60 verifiable points there is
more gap than finding, so no score is published at all — the result routes to a
manual review, because that is a booking rather than a report.

Seventeen of the hundred points (HTTPS, viewport, response time) come from the
HTTP response itself and are answerable no matter how the page renders.

### What counts as a signal

Only evidence about the response: how much readable text came back, how many
real links, whether a known mount point arrived **empty**, whether the page
ships the "you need to enable JavaScript" noscript block, whether the response
was cut short.

**Framework markers are not signals.** Next.js, Wix, Squarespace and Webflow all
server-render most of the time. Treating `__NEXT_DATA__` as proof of a shell
would put a low-confidence label on thousands of perfectly readable sites — the
mirror of the bug we are avoiding. Markers name the platform in the report and
nothing more. `test/fixtures/next-ssr.html` and `wix-ssr.html` exist to hold
that line.

> This is a deliberate deviation from the spec. Section 8 expects a Wix or
> Squarespace site to trigger low confidence. It should not: both platforms
> server-render, and most real small-business Wix sites are fully readable.
> The fixture asserts they score normally.

### The rescue

A one-page brochure site can have 300 characters of text and still be
completely readable — there is nothing more to see. If nothing suggests a shell
and the page barely uses script, confidence is high regardless of how thin the
text is. Without this, the tool would refuse to score exactly the kind of site
it exists to help.

### Mining what the shell still carries

Before concluding we cannot see anything, the audit reads JSON-LD, microdata,
meta tags and the embedded state blob (`__NEXT_DATA__`, Wix warmup data, inline
config). Client-rendered sites routinely ship their phone number, address and
booking link in there. A `tel:` link found in the payload is reported as a pass
marked `via: "embedded"`, because it will render.

### Other failure cases

| Case | Behaviour |
|---|---|
| Invalid URL | Inline validation in the browser, no request sent |
| Domain does not resolve | "We couldn't reach that address" |
| Resolves to a private network | Refused (SSRF guard, re-checked on every redirect hop) |
| 403 / Cloudflare / bot wall | Explained, manual review offered |
| Timeout past 6s | Partial result kept if bytes arrived, load-time check failed with a note |
| Non-HTML response | Rejected cleanly |
| Redirect to another domain | Followed, final URL reported |

## The invariants

`npm test` runs 142 assertions. Four of them run against every fixture and are
the promise the tool makes:

1. No render-sensitive failure is ever published when confidence is not high.
2. Anything positively found stays found, at any confidence.
3. A published score is never built on less than 60 verifiable points.
4. A suppressed failure leaves no failure text behind for a renderer to print.

The lock has its own set, and they scan the whole serialised payload rather
than trusting the fields we remembered to null. Deleting the redaction while
leaving the `locked` flag in place - the "blur only" bug - turns five of them
red and names the leaked strings.

These are worth mutation-testing after any change to `score.js`. Disabling the
downgrade rule makes the React shell fixture report 11 false failures and
publish a score of 17 — and turns 10 assertions red.

## Configuration

Everything tunable is in `src/config.js`: check weights, bands, chat vendors,
booking hosts, CTA phrases, form embeds, platform markers, fix copy, brand and
CTA URL, fetch timeouts, rate limit.

### The gate

The report renders in five sections:

| # | Section | State |
|---|---|---|
| 1 | Contact reachability | open |
| 2 | Capture mechanisms | open |
| 3 | Conversion basics | open |
| 4 | What these gaps are costing you | **locked** |
| 5 | Fix these, in this order | **locked** |

The first three name every issue on the site, pass and fail, with the evidence
for each. Nothing about *what* is wrong is hidden. The last two are the
analysis and the answers, and they arrive blurred behind a single panel
offering the call.

Both locked sections share one blur and one call to action - two identical
buttons stacked on each other is nagging, not persuasion.

### The lock is server-side

The blur is cosmetic. The actual lock is `redactLocked()` in `src/audit.js`:
the costed explanations and the fix instructions are **stripped from the
payload before it leaves the server**. Opening devtools on a locked report
finds placeholder bars and nothing to read.

What deliberately survives redaction:

- every check's label, status, points and evidence - sections 1-3 name every
  issue, and hiding those would defeat the product;
- `worstFailure.cost`, the single ungated teaser the spec asks for, which is
  printed on screen anyway;
- the fix list's ranks, labels and points, so the locked section can be drawn
  at the right size without inventing anything.

`GATE.locked_sections` in `src/config.js` moves the line; `enabled: false`
unlocks everything. No other file needs to change.

### Unlocking

| Caller | Unlocked? |
|---|---|
| `npm run audit -- site.com` | always - it calls the audit directly, it is your own machine |
| HTTP with a correct `x-audit-key` | yes |
| HTTP with a wrong key, or none | no |
| HTTP when `AUDIT_UNLOCK_KEY` is unset | no - a missing variable must never open the gate |

Set `AUDIT_UNLOCK_KEY` in the Netlify environment to a long random string to
enable the header. The comparison hashes both sides first, so it is
fixed-length and leaks neither the key's length nor where it first differs.

The public site never sends a key. It is there for your own runs against a
prospect's site before a DM - the second job in section 1 of the spec.

There is no email capture. The unlock is a booking, not an address.

Vendor lists go stale as tools come and go — that is a list to update, not code
to edit.

## Known limits

- **Chat widgets injected at runtime are invisible.** Nearly all chat tools are
  installed as a snippet in the page source, which is what we match. A widget
  that a site's own application code injects after load leaves no trace, so the
  check is worded as a claim about the source, not about the site.
- **Rate limiting is approximate at window boundaries.** The shared layer uses
  fixed windows, so a burst straddling a boundary can briefly reach twice the
  limit. Fine for a form a human presses.
- **Third-party embedded forms cannot be counted.** `form_present` passes,
  `form_fields_lean` returns unknown and says why.
- **Headless rendering is deferred.** If low-confidence results turn out to be a
  large share of real traffic, that is the trigger to revisit.

## Before you deploy

| | |
|---|---|
| `AUDIT_UNLOCK_KEY` | optional. A long random string enables the `x-audit-key` header for unlocked reports over HTTP. Unset means nobody can unlock over HTTP - your own runs go through `npm run audit`. |
| `RATE_SALT` | optional. Makes the hashing of caller addresses secret-keyed. |
| `SITE_URL` | optional. Netlify sets `URL` automatically; this only overrides it. |
| `AUDIT_CONTACT` | optional, and best left unset. Adds a contact to the user agent. If you ever set one, make it a role address on a domain you control - never a personal inbox, because it lands in the server log of every site scanned and those logs get harvested. |

Everything else is automatic. `URL` feeds the user agent, the CORS allowlist
and the social tags with no configuration.

### Headers and CSP

`scripts/build.js` generates `public/_headers`, including a
Content-Security-Policy whose script and style hashes are **computed from the
file that just shipped**. A hand-written hash goes stale the first time anyone
edits the page and silently blocks the whole app; a computed one cannot.

The policy is `default-src 'none'` with hashes for the one inline script and
the one inline style, `connect-src 'self'` for the audit endpoint, and
`frame-ancestors 'none'`. `npm run dev` applies the same file, so a broken
policy fails locally rather than on the live site.

`robots.txt` and `sitemap.xml` are generated by the same step, because they
need the address too. All three are build output and are gitignored.

### Accessibility

Every piece of text on the page clears WCAG AA (4.5:1), measured on the
rendered page rather than computed from tokens. That meant moving off two of
Apple's own values: systemBlue gives white text 4.02:1, and the standard gray
labels came in at 3.63:1 and 1.96:1. Hierarchy now comes from size and weight
rather than from fading text out, which is what the type guidance says to do
anyway.

`prefers-reduced-motion`, `prefers-reduced-transparency` and
`prefers-contrast` are all handled, including the lock: reduced transparency
drops the blur rather than leaving a haze over unreadable text.

### Telemetry

The function writes one structured JSON line per request - score, band,
confidence, timings, failure counts. **The scanned URL is never in a log
line**, because the footer promises no record of what you scanned and a log
line is a record. That gives you a funnel in the Netlify function log with no
third-party script, no cookies and nothing to disclose.

Real alerting and page analytics still need a service. Netlify Analytics is
the least invasive option, since it is server-side and needs no script - which
also means it cannot break the CSP.

### What protects the endpoint

It fetches arbitrary URLs on demand, so it needs to not become someone else's
scanner:

- **CORS is an allowlist**, not `*` - the live site, deploy previews and
  localhost. A request carrying any other `Origin` is refused outright. This
  stops a browser on someone else's page; it does not stop a script, which can
  omit the header.
- **Three layers of rate limiting** (`src/ratelimit.js`): per-IP in this
  instance, a per-instance total that catches a rotating-IP flood, and a
  shared per-IP and site-wide limit in Netlify Blobs that works across
  lambdas. `RATE_LIMIT.global_requests` is the wallet guard.
- **Caller addresses are never stored in plaintext.** The limiter sees a
  salted hash, held in one document per window, deleted when the window rolls.
- **SSRF guard** on every redirect hop.

### What the page promises

The footer says: *no sign-up, no email, and we keep no record of what you
scanned.* All three have to stay true. Nothing writes the scanned URL
anywhere - not a store, not a log line - so if you add analytics or logging,
do not log the URL, or change that sentence.

### How the scanner identifies itself

```
FlashbackLeadAudit/1.0 (+https://your-site; one page per request)
```

It names the tool and links to the site, which is the Googlebot pattern
(`+http://www.google.com/bot.html`) - a URL rather than an address. A URL can
be changed, cannot be spammed, and does not put an inbox in a stranger's logs.

That only works if the page it points at answers the question, so the footer
carries a line explaining what the scanner is and that it fetched one page
once. If you ever change that footer, keep that line - the user agent is
making a promise on its behalf.

A test asserts the user agent contains no `@` at all.

## Etiquette

One page fetched per request. No crawling, ever. A real descriptive
user-agent — not a spoofed browser string. Scanned URLs are not stored beyond
what the email gate captures.
