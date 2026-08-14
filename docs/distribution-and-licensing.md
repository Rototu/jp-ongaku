# Distribution, licensing, and the shape of a paid version

Notes from working out whether this can become a small paid product, and what
would have to change if it did. Nothing here is decided — it is the map, not the
route. **None of it is legal advice**; the one thing worth actually buying before
taking money is a couple of hours with an IP solicitor.

## The short version

The hard problem is not technical. It is that song lyrics are copyrighted, and
almost every design decision downstream is really a decision about who is holding
them and whether anyone licensed them.

The current design is in better shape than it looks. The app already runs
entirely on the user's machine, so there is no server of ours that lyrics pass
through. What is left is one unlicensed lyric source and one small terms-of-service
breach, both of them cheap to change, neither of them urgent while the project is
free.

## What the code does today

| Call | What it is | Verdict |
| --- | --- | --- |
| `youtube.com/oembed` — [`server/lyrics/youtube.ts`](../server/lyrics/youtube.ts) | Official public oEmbed endpoint, no key, built for third parties | Fine |
| `youtube.com/watch` + `"lengthSeconds"` regex — [`server/lyrics/youtube.ts`](../server/lyrics/youtube.ts) | Scrapes the watch page for the runtime, with a spoofed user agent | ToS breach, no copyright issue |
| `lrclib.net/api` — [`server/lyrics/lrclib.ts`](../server/lyrics/lrclib.ts) | Free crowdsourced lyric database, no key, **no publisher licences** | The real exposure |
| `ai-gateway.vercel.sh` — [`server/llm/provider.ts`](../server/llm/provider.ts) | Hardcoded gateway; lyrics reach a model provider through it | Fine today, wants to be configurable |

No captions are ripped from YouTube anywhere, which is the thing that would have
been genuinely hard to defend.

### The duration scrape

Runtime is a fact, and facts are not copyrightable, so there is no rights problem
here at all. What it does breach is YouTube's clause about accessing the service
by means other than the interface they provide — and the spoofed user agent makes
that hard to argue was accidental.

The official replacement is the YouTube Data API, `videos.list` with
`part=contentDetails`, which returns the duration under a free quota. It needs an
API key, which fits a bring-your-own-key design anyway.

### LRCLIB

This is the line a rightsholder's lawyer would point at.

LRCLIB is a real and openly run project, widely used by music players, and there
is nothing furtive about it. But it holds no publisher licences: its lyrics are
community-contributed, originally sourced from places that had not licensed them
either. Fetching from a source that is itself unlicensed, while charging money,
is precisely the situation *GS Media* addresses — a commercial operator is
presumed to know whether what it points at was lawfully posted.

The honest read: while this is a free project, LRCLIB is what everyone uses and
nobody is bothered. The moment money attaches, it becomes the thing to change.
Licensed alternatives are Musixmatch, Genius, and LyricFind.

The design implication is small and worth doing early regardless: make the lyric
source pluggable, so LRCLIB and a licensed provider are both just providers
behind one interface, and switching is configuration rather than surgery.

## Where the legal lines actually fall

### Linking is fine, with a catch

*Svensson* holds that linking to content that is freely and lawfully available is
not a communication to the public. *GS Media* adds the catch: link to unlawfully
posted content **for profit**, and knowledge is presumed. Practical consequence —
if the app ever offers "find the lyrics for this song" as outbound links, the
sources have to be a whitelist of licensed sites, never a general web search that
can surface scrapers.

Two rules follow. No snippets — title, artist, source name, link, nothing more,
because previewing two lines is reproduction. And no iframes — framing someone
else's page can itself be a communication to the public, and breaks their terms.

### Running locally changes who is liable

If the fetch happens on the user's machine, the user makes the copy. We are at
most a secondary party. Two UK cases pull in opposite directions:

- **CBS Songs v Amstrad (1988, HL)** — sold twin-deck tape recorders openly
  usable for piracy, held *not* to have authorised infringement: no control over
  use, and substantial lawful uses existed.
- **Twentieth Century Fox v Newzbin** — purpose-built to locate infringing
  content, curated toward it, paid subscription. Held to have authorised.

The line between them is purpose and control:

| Toward Amstrad | Toward Newzbin |
| --- | --- |
| Accepts any Japanese text | Exists to fetch lyrics |
| Lyric fetch is one input among several | Fetch is the main flow |
| No curated song index | We ship and maintain a song list |
| No control after install | We push scraper fixes when sites change |

That last row is the quiet one. Shipping a fix every time a lyric site changes
its markup demonstrates ongoing control and intent, in public commit history.
Amstrad sold a box and walked away.

### What a user does with it

There is no general private-copying exception in UK law — the one introduced in
2014 was quashed in 2015. The exception that does the work is s29 CDPA, fair
dealing for non-commercial research and private study. A learner copying lyrics
in order to study them fits that reasonably well. Design in a way that keeps it
true: text the user brings, for study, not a library we assemble for them.

### Patreon absolves nothing

Worth stating plainly because the intuition runs the other way. Patreon is a
payment rail; it transfers no liability. "Donations" are still trading income to
HMRC where patrons receive anything in return, and acting *for profit* is what
triggers the *GS Media* presumption in the first place — so it slightly worsens
the position rather than improving it.

Patreon's own terms also prohibit infringing content, which means a rightsholder
complaint does not produce a lawsuit. It produces an account termination.

## The actual threat model

No Japanese publisher is going to litigate against a UK sole trader with 200
patrons. The risk is **platform removal**, which is fast, unilateral, and
effectively unappealable at this size:

- Complaint to Patreon → income stops that day.
- DMCA to GitHub → *youtube-dl, 2020*: repo removed on an RIAA notice, restored
  only after EFF intervened and a great deal of public noise. That was a free,
  non-commercial project with enormous goodwill behind it.
- Apple notarisation revoked, or rejection from a distribution channel.

Hedges that follow: mirror the repo somewhere that is not GitHub, do not depend
on a single payment rail, self-host the download and update feed, and never write
"download lyrics from YouTube" in any public-facing text.

Note the tension — open sourcing improves the legal and moral position (not
selling the tool, patrons fund development) while worsening the platform
position, because a public repo is greppable and one notice away from removal.

## Distribution models considered

| Model | Legal exposure | Reach | Cost to run | Verdict |
| --- | --- | --- | --- | --- |
| Hosted, our lyrics library | Highest — we distribute | Highest | Servers + inference | No, unless licensed |
| Hosted, our key, metered | High | High | Servers + inference | Most engineering, real cost risk |
| Hosted, BYO key, user-supplied text | Moderate | Good | Servers only | Best reach/risk trade if hosting |
| **Local app, BYO key** | **Lowest** | Lowest | **£0** | Closest to what is wanted |
| Patreon source drop | Low | Lowest | £0 | Support burden is the killer |

The local model is the one that matches "a side thing": no servers, no inference
bill, no VAT machinery, no GDPR footprint, nothing to shut down after three
months of not touching it. The realistic ceiling is low — but £0 running costs
means revenue is pure upside and there is no runway pressure.

A note on the self-host route generally: install friction is brutal and support
goes *up*, not down. Every user is a bespoke environment with no logs, no repro,
and no ability to hotfix, which selects hard for a developer audience.

### Bring-your-own-key

The pattern that keeps coming out ahead. The user signs up with the provider
themselves, agrees to their terms, holds their own key. We are a client to a
relationship we are not party to — which is how legitimate clients for closed
platforms have always worked.

It applies to all three external services: the model provider (already nearly
there, just needs the hardcoded gateway URL in
[`server/llm/provider.ts`](../server/llm/provider.ts) made configurable), the
YouTube Data API, and a licensed lyrics API. Cost to the user is a signup;
benefit is that the licence sits where it belongs.

## Money, if it ever happens

### Entity and tax

Sole trader first — free, register for Self Assessment, done. A limited company
costs £50 plus roughly £800–1500 a year for an accountant, and is worth it around
£30k or when liability separation starts to matter.

VAT registration threshold is £90k UK turnover, which is far off. But digital
services sold to EU consumers incur EU VAT **from the first sale**, with no
threshold. A merchant of record — Paddle or Lemon Squeezy — becomes the seller
and absorbs that, at roughly 5% versus Stripe's 1.5%. For a side project that is
worth it: it buys back a compliance department. Patreon also handles VAT on
memberships.

### Data protection

Under the local model this nearly vanishes — the app holds nothing on our
servers. A short privacy policy still helps, and the ICO data protection fee is
about £52 a year (the "accounts and records / own marketing" exemption may
apply, worth checking).

Two things worth building regardless, because they are cheap now and expensive
later: export my data, and delete my account for real.

Language learners include under-18s, so if a hosted version ever happens the ICO
Age Appropriate Design Code is in scope. Cheapest mitigation is a 16+ term, no
marketing to children, and not collecting a date of birth we do not need.

### Consumer law

Digital content carries a 14-day cancellation right, waivable with explicit
consent to immediate access — put that in checkout. The DMCC Act tightens
subscription rules: clear pre-contract information, renewal reminders, easy exit.
Build cancellation as one click with no email required, which is also just good
product.

### Pricing, if hosted

The cost driver is LLM tokens per lesson build, so meter the thing that costs
money rather than the thing users love.

- **Free**: a few lessons a month, unlimited review of what already exists.
  Never expire content someone has already made — losing an SRS deck is hostile;
  hitting a "make new lesson" wall is fair.
- **Paid**: one tier, around £6/month or £48/year. A generous cap stated openly
  as fair use, not "unlimited*".
- No card for the free tier, and no trial that auto-charges.
- Credit packs for people who will not subscribe — converts the "I only study
  before a trip" crowd.
- Founding price for early users. Prefer this to lifetime deals, which sell the
  most expensive resource to the least committed customers.

Instrument the actual token cost per lesson before setting any of these numbers.

### Sponsorship, if open source

Use **GitHub Sponsors, not Patreon** — 0% versus 8–12%, and the button sits on
the repo where people find the project.

Tiers that work, roughly in order:

1. **Early access** — features land for sponsors two to four weeks before main.
   No infrastructure, no cost, no promises about *what* gets built.
2. **Prebuilt binaries** — genuinely saves people installing a runtime.
3. **Signing certificates as a public milestone** — "at 15 sponsors, signed
   builds". Turns a cost into a visible goal rather than an abstract ask.

"Sponsors can suggest features" is a weak headline tier. The reward requires work
to consume and pays off uncertainly, and it builds an obligation treadmill:
roadmap responsiveness owed to paying strangers, indefinitely, on a side project.
Fine as a perk on top of something else.

Calibration: an open source project with ~1,000 active users typically converts
5–20 sponsors at £3–5. Plan for £30–100 a month, not a multiple of it.

### Licence

Decide before accepting contributions, because relicensing afterwards means
chasing every contributor. **AGPL** keeps the door open for us to run a hosted
version while closing it for others; **MIT** maximises adoption and protects
nothing. AGPL plus a CLA preserves the most options.

## Shipping binaries without paying for certificates

Unsigned releases are the norm for open source, and paying frequently does not
buy what one assumes.

**Windows.** SmartScreen is reputation-based, not signature-based. A standard OV
certificate (~£200/year) still shows "Windows protected your PC" until enough
downloads accumulate, which for a niche tool may be never. Only EV certificates
get instant reputation, at £300+ a year plus a hardware token plus business
verification. Skip it.

**macOS.** Apple Silicon requires *some* signature, but **ad-hoc signing is
free**:

```bash
codesign --force --deep --sign - YourApp.app
```

That is the difference between "app is damaged and can't be opened" — which looks
broken — and "developer cannot be verified", which obviously is a permissions
prompt. macOS 15 removed the right-click → Open bypass, so the current path is
System Settings → Privacy & Security → Open Anyway. Worth putting in the README
with a screenshot; that dialog is where most of the drop-off happens.

Apple's £79 a year is the only signing spend that genuinely delivers, since
notarisation removes the dialog outright. Defer it until there are non-technical
users at volume.

**Better than a certificate, and free:**

- **Homebrew cask** strips the quarantine attribute, so no dialog at all. Highest
  leverage move on macOS. `winget` and Scoop are the Windows equivalents.
- **`bunx` / `npx`** — no Gatekeeper, no SmartScreen, no signing surface
  whatsoever. The app is already a local server plus a web UI, so this path costs
  nothing and sidesteps the entire problem. Electron is a packaging preference,
  not a requirement, and it is the only thing creating a certificate bill.
- **GitHub artifact attestations** — free build provenance from Actions. A
  different mechanism from OS signing, but a real trust signal, and more than
  most unsigned projects offer.

## Sync

Device-to-device sync is the right instinct — nothing should pass through our
servers — but building peer-to-peer means NAT traversal, conflict resolution, and
key exchange, which is weeks of work.

The simplest thing that meets the goal: a plain data file in a user-chosen
folder, pointed at their own iCloud, Dropbox, or Syncthing. Zero infrastructure,
zero liability, zero engineering. If a relay is ever wanted, end-to-end encrypted
with keys we never hold reaches roughly the same position — but the folder gets
100% of it for free.

## If this were to go ahead

1. Make the lyric provider pluggable, and the model gateway URL configurable.
   Both are small, both are useful regardless of any of the above.
2. Replace the watch-page duration scrape with the YouTube Data API.
3. Ship as `bunx`, unsigned. No certificates, no Electron.
4. Open source under AGPL, GitHub Sponsors, early access as the tier.
5. Only if there is real demand: swap LRCLIB for a licensed provider, and get a
   solicitor's written view on the specific design before charging.

Explicitly not now: incorporating, trademarks, a marketing site, or a lawyer.
None of those matter before knowing whether anyone will pay.
