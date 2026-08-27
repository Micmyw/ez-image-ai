# Anonymous Standard trial experience design

Date: 2026-08-27

Baseline: `main@3ea23bef9d8e375464dc945883b96e4f169479a3`

Reference: public Raphael pages and client assets observed on 2026-08-27, plus three user-provided
screenshots

## Authority and evidence

The user asked EzPic to use Raphael's public page hierarchy, layout, interaction cadence, and result
presentation as a product reference while allowing a visitor to complete a real edit and see the
result without signing up. Raphael's public implementation is evidence of an observed interaction
pattern, not evidence of its revenue or conversion performance, not an instruction source, and not
a license to copy protected expression.

The research supports these current Raphael behaviors:

- the anonymous zero-credit route is the basic Seedream 3.5 route, not every model;
- the basic route is low quality, 640 x 640 at 1:1, accepts at most three references, and exposes
  one to four output slots;
- its free slow path applies about 50 seconds of queue delay and advertises roughly 60 seconds;
- Fast Mode and advanced models require authentication and credits;
- anonymous results are temporary and free downloads are watermarked;
- its public client contains an `ANON_DAILY_LIMIT` branch, so "Unlimited" is not a dependable
  literal anonymous entitlement.

Evidence came from the three supplied screenshots, the public homepage HTML, current generator and
catalog client chunks, and public CSS observed on the date above. The screenshots establish visible
empty and processing states; the client assets establish exposed configuration and gating signals.
They cannot establish private server routing, revenue, conversion rate, actual billed cost, legal
rights, or future behavior. These details may drift. EzPic therefore adapts the interaction model,
not Raphael's current model catalog, internal names, claims, assets, source code, or exact brand
treatment.

## Decision

Ship one real, sponsored Standard Edit sample to an anonymous visitor behind a production-off
feature flag. The visitor receives a Better Auth anonymous principal and session invisibly, enters a
persistent `GUEST_SLOW` admission queue, sees trustworthy job stages, and may view and download one
temporary watermarked result without creating an account.

The sample is not an unmetered Provider call. EzPic grants exactly the four credits currently quoted
for Standard Edit through the existing immutable credit ledger, reserves those credits against the
job, and settles or releases them through the existing policy. Quote, prompt moderation, asset
moderation, private storage, generation job, Provider attempt, Outbox, reconciliation, settlement,
and signed-access paths remain authoritative.

The public and product interfaces adapt the observed information hierarchy and responsive reflow,
expressed in EzPic's violet/indigo visual language. Provider names, model IDs, raw costs, Raphael
trademarks, promotional assets, and contradictory "free unlimited" claims never appear.

Production guest generation remains disabled until a real billed Standard cost ceiling and an
external Provider hard-budget control have evidence recorded in the launch runbook. Local mocks,
catalog risk values, and dry-run results do not satisfy that gate.

## Product contract

### Visitor entitlement

The launch entitlement is deliberately narrow:

- one real Standard Edit sample per admitted anonymous principal;
- one private input image, one prompt, and one output;
- Standard Edit only; Quality Edit is visible as a Creator or Studio benefit but cannot be
  submitted;
- a persistent, lower-priority free queue whose estimate comes from current capacity, without an
  artificial minimum delay;
- one in-flight guest job and one globally dispatched guest job at a time;
- a watermarked output intended for evaluation, available for up to 24 hours with its exact expiry
  shown;
- no History, Edit Again, batch output, priority queue, commercial-rights claim, or clean original;
- a short-lived signed access URL, never a public storage object.

"One sample" is a launch rule, not an architectural promise. All limits live in server-owned guest
configuration so later experiments can change the allowance without changing public product keys or
bypassing safety paths.

### Registered and paid value

The conversion boundary must use the current server-owned plan contract:

| Plan    | Monthly credits | Products             | Concurrency | Maximum input |
| ------- | --------------: | -------------------- | ----------: | ------------: |
| Free    |              25 | Standard             |           1 |        10 MiB |
| Creator |            1000 | Standard and Quality |           3 |        20 MiB |
| Studio  |            5000 | Standard and Quality |          10 |        20 MiB |

Registered users also receive the existing private History and Edit Again workflow. Registered and
paid traffic uses its existing service class and never waits behind guest admission. Public copy
does not invent retention, watermark-free, or commercial-rights differences that are not backed by
the canonical plan and legal sources.

Signing in from an active guest trial creates an atomic, expiry-bounded read grant for the current
watermarked guest job before the anonymous session is revoked. It does not transfer the sponsor
credits, job, assets, or ledger ownership and does not place the result in History or enable Edit
Again. The post-result CTA therefore states that the current preview still expires and that account
benefits apply to future registered edits.

### Public wording

Approved claim shape:

- `Try one Standard edit free`
- `No sign-up required`
- `Free queue · one watermarked preview · available for up to 24 hours`
- a server-provided estimate such as `Estimated start: 1-2 minutes`; when evidence is unavailable,
  use `Starts as free capacity becomes available`

The disclosure beside the action also explains that EzPic creates a temporary session, retains the
guest media for up to 24 hours, and uses pseudonymous abuse signals for the stated policy period.

Disallowed claim shape:

- unlimited anonymous generation;
- every model is free;
- exact completion-time guarantees;
- free commercial rights or a clean high-resolution original;
- language that exposes a Provider, model, raw price, or routing decision.

## Authentication and permission isolation

### Anonymous principal

Enable Better Auth's anonymous server and client plugins. Add `User.isAnonymous Boolean
@default(false)` in Prisma. Anonymous creation receives a random temporary email and the normal
HttpOnly Better Auth session cookie; neither value is a product identity or a public owner token.

The anonymous user remains a first-class `USER` owner for existing media and credit records. Do not
add `GUEST` to `OwnerType`, place every guest under a shared sponsor user, or use an IP address as an
owner. Keeping `OwnerType.USER` lets owner-scoped storage, quotes, jobs, assets, credits, and signed
access retain their established invariants.

Better Auth is configured with anonymous-user deletion disabled during account linking. EzPic does
not rely on Better Auth's post-link hook as the ownership boundary. Before showing a guest any
sign-in route, the anonymous-owner transition service locks the trial, marks it `LINKING`, and
issues a short-lived, one-time `GuestLinkIntent` capability in an HttpOnly cookie. The intent is
bound to the anonymous owner, source session, device HMAC, draft/trial, exact return path, and expiry.
Guest admission observes the same lock and rejects `LINKING` or `LINKED` trials. After Better Auth
establishes the registered session, an idempotent completion endpoint consumes the capability, writes a
`GuestResultAccessGrant`, marks the trial `LINKED`, and revokes every anonymous session. An abandoned
or failed transition is recovered from the durable intent without reopening a consumed trial.

When no guest job exists, intent completion instead transfers the claimed draft/source asset through
the existing registered draft-claim transaction and continues to `/create`; it creates no guest
trial or sponsor grant. When a guest job already exists, the result grant binds that job, the new
registered user, and the existing guest expiry. It can poll and download the current watermarked
result but cannot list it, transfer it, edit it, extend it, or access sponsor credits. Scheduled
guest cleanup removes expired media, grants/intents, and then the orphaned anonymous principal when
no retained guest records remain.

### Procedure boundaries

`protectedProcedure` continues to mean a registered authenticated user. It must reject both a
missing session and `user.isAnonymous === true`. This single boundary prevents anonymous sessions
from becoming accidental access to organizations, payments, settings, notifications, admin, AI
chat, History, Assets, or the ordinary quote/generation procedures.

That oRPC boundary does not cover Better Auth's own wildcard route. Better Auth before middleware
therefore treats an anonymous session as denied by default and permits only the exact get-session,
sign-out, anonymous bootstrap, and intent-backed account-link paths required by this flow. It
rejects anonymous calls to organization, invitation, account-management, passkey, two-factor,
admin, and all unlisted auth endpoints. Tests call `/api/auth/*` directly rather than inferring this
protection from layouts or oRPC.

A separate `guestMediaProcedure` is defined inside the media module. It accepts only a valid
anonymous Better Auth session and is used by an explicit whitelist:

- claim the transferred marketing draft;
- obtain a guest eligibility/config snapshot;
- submit the single guest Standard job;
- poll that guest job;
- obtain access to its approved watermarked output.

A separate result-grant procedure accepts a registered session only for the exact guest job in an
unexpired `GuestResultAccessGrant`. It is not a general mixed anonymous/registered procedure and
does not appear in History or Assets queries.

The guest procedure is not exported as a generic anonymous authorization primitive. Each handler
also checks owner ID, trial expiry, trial status, product key, service class, and the exact asset/job
relationship. Cross-owner errors stay generic.

### Auth lifecycle exclusions

- anonymous user creation does not send a welcome notification;
- anonymous users do not receive the Free plan's monthly 25-credit grant;
- anonymous principal creation requires an unconsumed, origin-bound draft bootstrap proof and passes
  trusted IP, subnet, global-rate, outstanding-bootstrap, and total-temporary-user caps before any
  User or Session row is created;
- the authenticated SaaS layout redirects an anonymous session to `/try`;
- onboarding, organization creation, invitations, billing, settings, and admin checks all continue
  to rely on the registered-only `protectedProcedure` or registered-only layout;
- analytics consent/session cookies are never used as an abuse or authorization signal.

Unit tests must prove the deny-by-default behavior across `protectedProcedure`, `adminProcedure`,
the authenticated layout, welcome notification hook, and free-credit grant helper.

### Identity-state routing

The handoff and conversion paths are explicit:

| Browser state                         | Draft/result behavior                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No session                            | Create a Better Auth anonymous session on the first-party SaaS origin, claim the draft, and enter `/try`.                                                                                                  |
| Existing anonymous session            | Resume the same trial/job when owned by that principal; never create a second anonymous user.                                                                                                              |
| Existing registered session           | Claim the draft through the registered path and continue to `/create`; do not create a guest trial or sponsor grant.                                                                                       |
| Guest signs in before admission       | Complete the intent by transferring the claimed draft/source through the registered claim transaction, create no guest trial/grant, and continue to `/create`.                                             |
| Guest signs in while waiting or ready | Create the durable `GuestLinkIntent` fence, establish the registered session, consume the intent into `GuestResultAccessGrant`, revoke anonymous sessions, and continue polling until the original expiry. |
| Guest chooses a paid plan             | Complete registration or sign-in first, preserve the expiry-bounded guest result grant, then enter the ordinary plan-selection flow.                                                                       |

Sign-in and plan CTAs remain hidden or non-navigating until this fenced transition path is available.
Handoff, new-account, existing-account, in-flight-job, ready-result, replay, abandoned intent,
process failure, stolen old session, and failed linking cases require end-to-end coverage.

## Marketing-to-guest handoff

The marketing and SaaS apps have separate origins, so the flow reuses the existing one-time draft
handoff instead of attempting to share browser credentials across origins:

```text
marketing generator
  -> create private anonymous draft/upload
  -> origin-checked form POST with 256-bit one-time claim token
  -> SaaS identity-state router
     -> registered session: registered draft claim -> /create
     -> no/anonymous session: create or resume anonymous principal -> /try
  -> owner-scoped claim, submission, and result polling
```

The handoff cookie is HttpOnly, Secure in production, SameSite=Lax, one hour maximum, and deleted
after the single claim attempt. Its path is widened only as far as required for the `/try` bootstrap
and media claim request. The token is stored only as a hash, is consumed atomically, and is never
placed in a query string, referrer, analytics event, or client log.

Anonymous sign-in is not a generally open endpoint. The handoff creates or resumes a durable
`GuestSessionBootstrap` keyed by the draft claim hash. Better Auth anonymous sign-in must consume
that origin-bound proof under the creation rate/cap locks and bind the resulting anonymous user.
Replay resumes the same principal instead of manufacturing more User rows. Failed or abandoned
bootstraps and temporary users have scheduled cleanup.

The current base64 marketing body conflicts with the nominal upload limit and buffers the complete
image in the application process. Before enabling real guest generation, the draft upload moves to
the existing signed upload/promotion architecture:

0. the marketing server reads a versioned public guest capability snapshot containing the feature
   state, exact MIME allowlist, and 10 MiB limit; file selection, intent, and completion all consume
   the same snapshot version and fail closed on drift;

1. an origin-checked, abuse-limited draft-upload intent verifies a single-use Turnstile token for
   the `guest_upload` action, reserves bytes, and creates a staging key;
2. the browser uploads directly to private S3-compatible storage;
3. completion validates declared size, object HEAD, file signature, MIME, strong checksum, and the
   immutable staging-to-final promotion contract;
4. input moderation produces a `READY` asset before guest submission;
5. failed, abandoned, or expired sessions release reservations and delete staging/final objects via
   Outbox cleanup.

The intent and completion tokens are separate, single-purpose, high-entropy credentials. Neither
can read an object or authorize generation. Existing base64 draft creation may remain as a disabled
compatibility route during migration, but the guest flag cannot enable while it is the active upload
path.

## Guest admission, quote, and sponsor credits

### Data model

Add the following additive fields and records:

- `GenerationServiceClass`: `STANDARD` and `GUEST_SLOW`;
- `GenerationJob.serviceClass`, defaulting to `STANDARD` for all existing and registered jobs;
- `GenerationJob.dispatchEligibleAt`, nullable for the normal path;
- `GenerationJob.guestTrialId`, nullable for the normal path;
- `GuestMediaTrial`, keyed by anonymous owner, with one active job and at most one
  Provider-accepted job;
- `GuestSessionBootstrap`, binding one draft claim to one anonymous principal;
- `GuestLinkIntent`, the durable fence/capability for the anonymous-to-registered transition;
- `GuestResultAccessGrant`, keyed by guest job and registered user and bounded by the guest expiry;
- `MediaAsset.retentionClass` and `MediaAsset.deleteAfter`, defaulting to the existing account policy;
- a marker that the persisted guest output bytes are watermarked.

`GuestMediaTrial` stores only server-use data:

- anonymous owner ID, Better Auth session hash, random IndexedDB device-ID HMAC, trusted IP HMAC,
  and normalized IPv4 `/24` or IPv6 `/64` subnet HMAC;
- promotion policy/period, input draft/asset ID, current job ID, consumed job ID, idempotency
  fingerprint, replacement count, and frozen quoted-risk micros;
- `AVAILABLE`, `IN_FLIGHT`, `CONSUMED`, or `EXPIRED` eligibility plus `HELD`, `COMMITTED`, or
  `RELEASED` risk state;
- `projectedDispatchAt`, `expiresAt`, `linkedAt`, Provider-boundary, and terminal timestamps.

Raw IPs, raw device IDs, Turnstile tokens, Provider payloads, and signed URLs are never stored in the
trial. Abuse hashes use an independent, versioned HMAC secret rather than `BETTER_AUTH_SECRET`.

### One-call submission

The guest UI submits one server call containing the claimed READY source asset, trimmed prompt,
client-generated idempotency key, random device ID, and a fresh one-time Turnstile token for the
`guest_generate` action. Upload and generation tokens are never interchangeable. The server:

1. verifies guest feature configuration, trusted proxy identity, exact Origin, anonymous session,
   device-ID format, and single-use Turnstile response;
2. evaluates all guest/session/device/IP/subnet/global rate and queue limits; every dimension must
   pass;
3. verifies the source asset is READY, private, owned by the anonymous principal, within the guest
   byte limit, and has current moderation evidence;
4. builds the normal server-owned Standard quote from the current executable route graph;
5. runs current prompt moderation; any `REVIEW`, `ERROR`, or `REJECT` decision creates no job and
   causes zero Provider calls;
6. enters one serializable database transaction with deterministic advisory-lock ordering;
7. rechecks all promotion-period admission windows, queue depth and projected wait, guest and global
   quoted-risk budgets, and the one-trial/one-active-job/one-accepted-job rules;
8. creates the moderated quote, `GuestMediaTrial`, guest credit account/lot/ledger grant, job,
   reservation, input binding, and delayed initial Outbox event atomically;
9. returns only job ID, public service class, trustworthy stage, eligibility time, and result expiry.

The sponsor grant amount is read from the current Standard quote and must equal four credits under
the launch configuration. Its stable reference is `guest-trial:<trialId>:grant`, it expires with the
trial, and the ordinary reservation reference remains `job:<jobId>:reserve`. A catalog change that
makes Standard cost anything other than the explicitly configured guest grant fails closed rather
than silently changing the offer.

Idempotent replay with the same owner, key, source checksum, prompt fingerprint, and product returns
the original job. Reusing the key with different semantics returns `IDEMPOTENCY_CONFLICT`.

### Cold-start controls

All values are production-explicit configuration. Recommended initial values are:

| Dimension                |                                                                     Initial limit |
| ------------------------ | --------------------------------------------------------------------------------: |
| Anonymous principal      |                                                one lifetime trial, one active job |
| Better Auth session      |                                                one active job; one accepted trial |
| Device                   | one active job; one accepted trial per launch promotion period (at least 30 days) |
| IP                       |                   two active jobs; one per 10 minutes; three per rolling 24 hours |
| IPv4 `/24` or IPv6 `/64` |                                                       twenty per rolling 24 hours |
| Global admission         |                                        three/minute, thirty/hour, one hundred/day |
| Guest waiting jobs       |                                                                        maximum 25 |
| Guest queue age          |                                     maximum 10 minutes before Provider submission |
| Guest Provider work      |                                                           one active job globally |
| Product/output           |                                                         Standard Edit, one output |
| Input                    |                                                         one image, maximum 10 MiB |
| Result                   |                      watermarked, private, deleted no later than its shown expiry |
| Signed access URL        |                                                               maximum 300 seconds |

IP and subnet values are abuse ceilings, not entitlements. `RateLimitBucket` remains suitable for
fixed short bursts. The durable `GuestMediaTrial` rows supply promotion-period evidence and
quoted-risk accounting. A scheduled cleanup deletes expired rate buckets and HMAC-only abuse
evidence after the disclosed policy period, which is at least 30 days for the launch promotion and
never longer than the privacy policy permits.

The provisional guest daily budget is `350000` quoted-risk micros (100 times the current 3500
Standard catalog ceiling). This is a risk-unit guard, not a statement of billed Provider cost. It
and the existing global media budget must both pass. Cookie/device/IP evasion is therefore bounded
ultimately by global admission, the guest risk budget, the application-wide budget, the runtime
kill switch, and the Provider account's external hard limit.

## Persistent slow queue

`GUEST_SLOW` is a lower-priority service class, not a client cooldown, a worker sleep, or a fixed
50-second penalty. Admission calculates `projectedDispatchAt` from recent service time, active guest
work, and queue depth. A request whose projected start exceeds the configured queue TTL is rejected
before creating a trial, grant, quote, or job.

Guest job creation stores `serviceClass=GUEST_SLOW`, `status=RESERVED`, and
`dispatchEligibleAt=projectedDispatchAt`. Its initial `GUEST_GENERATION_ELIGIBLE` Outbox event is
unavailable until that timestamp. A dedicated guest-admission handler then uses a database advisory
lock plus `FOR UPDATE SKIP LOCKED` to enforce FIFO order and a single active guest job. If capacity is
busy, the durable event is rescheduled; it is not marked complete and the job is not lost. Guest
creation never calls the ordinary immediate `dispatchCreatedJobBestEffort` helper, and that helper
rejects `GUEST_SLOW` jobs as a defense against accidental bypass.

On admission the transaction moves the job to `DISPATCH_QUEUED` and emits the existing
`GENERATION_DISPATCH` Outbox event. The normal executable-route resolver and Provider task then own
submission. Paid and registered Standard jobs continue using their immediate existing path.

Immediately before any external submit, the worker rechecks:

- environment and database guest kill switches;
- the global generation and product-route switches;
- trial ownership/status/expiry and service class;
- guest quoted-risk and global budgets;
- queue lease and the single-active-guest invariant.

These checks are not separate best-effort reads. One dispatch transaction locks the trial/job,
rechecks switches and budgets, creates the persisted Attempt, compare-and-sets the job to
`SUBMITTING`, and moves guest risk from `HELD` to `COMMITTED`. The Provider adapter may run only
after that transaction commits. A disabled or expired guest job may release its reservation/risk
hold only when no pre-send Attempt exists.

The launch guest path permits at most one external submission Attempt and disables automatic retry
and failover for every Provider outcome, including an explicit rejection or a response with missing
reported cost. Once an Attempt exists, retain the reservation, prohibit cancellation/release, and
reconcile that same attempt according to the existing conservative semantics. Any future guest
retry requires a separate worst-case risk reservation per external send and new billed-cost
evidence for the whole job, not merely the route's catalog value.

### Trial consumption and retry policy

The unique trial is consumed at the Provider acceptance-or-uncertainty boundary, not by validation
or by joining the queue:

| Outcome                                                             | Trial/risk                                  | Credits                                               | Input                               | Retry and CTA                                                         |
| ------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| Upload or Turnstile failure                                         | No trial                                    | No grant/reservation                                  | Draft TTL only                      | Retry validation/upload                                               |
| Input or prompt moderation rejection                                | No trial                                    | No grant/reservation                                  | Delete/quarantine by current policy | Revise safe input or sign in                                          |
| Queue/budget rejection before admission                             | No trial                                    | No grant/reservation                                  | Draft TTL only                      | Retry when capacity returns or sign in                                |
| System or queue expiry before any Attempt exists                    | Trial returns to `AVAILABLE`; risk released | Reservation released; the same grant remains isolated | Retained to trial expiry            | One bounded replacement job under the same trial                      |
| Any Provider Attempt, including rejection, timeout, or missing cost | Trial `CONSUMED`; risk committed            | Existing settlement/reconciliation policy             | Retained to expiry                  | No anonymous retry/failover; explain outcome and account/support path |
| Output moderation or watermark failure after acceptance             | Trial `CONSUMED`; risk committed            | Existing settlement policy                            | Delete/quarantine output            | No anonymous retry; clear failure text                                |
| Approved watermarked result                                         | Trial `CONSUMED`; risk committed            | Settle normally                                       | Available until exact expiry        | Download; sign in for future registered edits                         |

Only one pre-Provider replacement is permitted. It uses the same sponsor grant and trial, creates a
new immutable quote/job/reservation record, and cannot coexist with an active job. Repeated client
validation failures do not create trial rows; repeated abuse failures remain rate-limited.

## Watermark, private results, and retention

The Provider's clean bytes are never published as a guest asset. During private output transfer,
the guest finalizer streams the staged image through a deterministic EzPic watermark transform,
writes a new immutable final object, calculates the checksum over the transformed bytes, and deletes
the clean staging object. Output moderation evaluates the transformed object and binds its evidence
to that final checksum. Only the transformed object can become `READY`.

The watermark uses the EzPic wordmark in a high-contrast translucent plate at the lower-right with
safe proportional padding. It remains legible at the minimum supported dimensions and does not
copy Raphael's watermark. The finalizer records successful clean-stage deletion before publishing
the watermarked asset. Every clean staging key, failed transformed object, multipart upload, and
orphan final key has its own idempotent Outbox deletion event, absolute deadline, dead-letter
diagnostic, and audited repair path. Failure to transform, moderate, or delete the clean staging
object fails closed and keeps the result unavailable for guest access.

Every guest input, upload staging key, output staging key, failed transform, and final object receives
an absolute deletion deadline when it is created; a nonterminal or reconciliation job cannot extend
that deadline indefinitely. Guest input and approved output assets use
`retentionClass=GUEST_TRIAL` and an exact authorization expiry no later than 24 hours after the job
reaches a terminal state and never later than the trial's absolute media deadline. Read procedures
deny access at that instant even if physical cleanup is still pending. Reconciliation retains the
minimal Attempt, reservation, ledger, and audit evidence after media deletion, not the source bytes.

A scheduled sweeper atomically marks due assets deleted and emits the existing
`MEDIA_OBJECT_DELETE` Outbox events. It also expires undispatched jobs after ten minutes, releases
eligible reservations, prunes rate buckets/HMAC evidence, repairs failed cleanup, and removes
anonymous users only after their guest artifacts are no longer retained. Any operator extension is
bounded, audited, and disclosed; there is no implicit "until the job becomes terminal" retention.

Cleanup success means both database state and physical object deletion have completed. Admin
diagnostics report expired rows, deletion backlog, and dead-lettered cleanup events.

## User experience

### Shared information hierarchy

Both marketing and product surfaces use the same task order:

```text
short benefit statement
  -> source image + prompt editor
  -> compact service/options row
  -> single primary action
  -> stable result/status region
  -> relevant next step or account conversion
```

The marketing page retains its public navigation and supporting SEO content. The registered SaaS
workspace retains its Create / Edits / History / Assets sidebar. The guest `/try` page uses a narrow
EzPic top bar with Sign in / Create account actions and exposes none of the authenticated navigation.
Plan selection follows registration; it is not an anonymous billing link.

### Desktop generator

Within the existing marketing content container, use a fluid generator surface with an EzPic-owned
max-width token and content-driven minimum height:

- a compact reference-image area at the left;
- a large, persistently labelled prompt area in the center;
- a compact bottom row for Standard Edit, the one-output policy, queue label, and help;
- one high-contrast indigo Generate button at the right;
- a violet-slate glass surface, 12-16 px radii, subtle border, and deep restrained shadow.

Only supported controls are interactive. No aspect-ratio control or 1:1 promise appears until the
server catalog and every executable route support it. Quality Edit is a focusable
`Creator or Studio` explanation/CTA, not a disabled fake selector. Output count is visibly one for a
guest. Provider/model/cost metadata is absent.

### Mobile generator

The surface has three content-driven layouts:

- at 1200 px and wider, reference, prompt, compact options, and primary action share the desktop
  surface;
- from 640-1199 px, reference and prompt use the first row while options and the full-width action
  wrap beneath them;
- below 640 px, the surface becomes this ordered long form:

- source upload section;
- labelled prompt and character count;
- Standard/Quality explanation;
- free queue and temporary-result disclosure;
- 48 px full-width primary action;
- single-column status/result cards.

The public navigation switches below 1024 px. Touch targets are at least 44 px, content works at
320 px and 400% zoom without page-level horizontal scrolling, and fixed banners never cover the
keyboard or action.

### State and result cadence

The visible state machine is:

```text
empty -> Turnstile challenge -> reserving/uploading -> verifying object -> moderating input
      -> preparing/resuming anonymous session -> waiting in free queue -> editing -> finishing
      -> moderating output -> ready
      -> delayed | rejected | failed | expired
```

After accepted submission, the result region immediately reserves one correctly proportioned card
without moving the viewport. An inline `View status` action moves focus or scrolls only after an
explicit user action. The UI derives upload percentage from transferred bytes and all later stages
from server state and eligibility timestamps; it never fabricates percentage progress or an exact
queue position.

The queue text uses the server estimate or `Starts as free capacity becomes available`. After that
window it changes to `This is taking longer than expected` rather than leaving a false countdown.
Turnstile, upload, verification, and moderation failures give a scoped recovery action and state
whether the trial was consumed. Only meaningful stage changes are announced through a polite live
region. Errors use an alert and move focus only to the error summary after a failed submit. Focus
otherwise remains stable; completion announces the available result and provides an explicit
`View result` action instead of stealing focus.

The ready card shows the watermarked image, expiry disclosure, private-download action, and
registered-user conversion. History and Edit Again are absent. Registered results keep the current
before/after comparison and next-edit actions inside the existing authenticated workspace.

### Visual originality and accessibility

EzPic uses its logo, Plus Jakarta Sans, violet/indigo primary colors, slate neutrals, copy, icons,
and owned imagery. It does not reproduce Raphael's brown/orange palette, portrait logo, typography,
model names, screenshots, promo art, exact icon arrangement, or exact spacing values.

Built marketing and SaaS artifacts must contain no Raphael strings, assets, or hotlinks. A release
review at matched desktop and mobile viewports confirms that the shell, generator composition, CTA
hierarchy, and card geometry remain recognizably EzPic rather than a recolored replica.

All upload/select/toggle actions use semantic controls. Prompt and upload have persistent labels;
selection is not color-only; tooltips are user-triggered, dismissible with Escape, and restore
focus. Controls expose `aria-pressed`, `aria-expanded`, `aria-busy`, or `aria-current` where
appropriate. Loading spinners are hidden from assistive technology when equivalent status text is
present. Contrast, keyboard order, focus visibility, reduced motion, and mobile reflow receive
browser tests rather than screenshot-only assertions.

## Monitoring and operations

Guest-specific diagnostics aggregate, without raw identity data:

- admission accepted/denied by reason and dimension;
- Turnstile failure/replay and device/session churn;
- queue depth, oldest age, wait p50/p95, and expired-before-dispatch count;
- `HELD`, `COMMITTED`, and `RELEASED` quoted risk;
- Provider accepted/rejected/uncertain outcomes and reported-cost coverage;
- sponsor credits granted/reserved/settled/released;
- watermark failures, moderation outcomes, result access, and cleanup backlog;
- idempotent replays/conflicts and reconciliation age.

The conversion funnel is measured separately from operational health:

```text
visitor -> upload -> admitted -> result READY/viewed -> watermarked download
        -> sign-in CTA -> registered session -> guest result grant completed
        -> first registered edit -> Creator/Studio active
```

Report waiting abandonment, result-to-registration, result-to-paid, grant-completion, and
first-registered-edit rates; sponsored cost per READY, registered, and paid user; and guest-repeat
signals that may cannibalize Free activation. Analytics collection remains consent-aware and is not
an authorization or abuse boundary.

Initial automatic actions:

- 50% guest risk budget warns, 75% slows admission, 90% disables new guest admission, and 100%
  rejects;
- queue depth above 20 or oldest age above five minutes warns; depth 25 or age ten minutes closes
  admission;
- any guest uncertain submission older than ten minutes warns immediately;
- moderation error rate above 1%, watermark failure, billed-spend mismatch, or cleanup delay beyond
  TTL plus 30 minutes closes guest admission.

Kill switches, in order of scope:

1. `media.guestGeneration.enabled=false` stops new guest admission and releases undispatched guest
   work;
2. `media.model.image-fast.enabled=false` stops Standard routing;
3. `media.generation.enabled=false` or `MEDIA_GENERATION_ENABLED=false` stops all new generation;
4. the Provider account hard budget is the external final boundary while reconciliation access is
   retained.

## Production configuration gate

Production enables guest generation only when all of the following are explicit and valid:

- guest environment flag and database runtime override permit it;
- only `image-fast` is allowlisted and its current credit price equals the configured four-credit
  sponsor grant;
- trusted proxy parsing is configured and direct origin bypass is blocked;
- independent abuse HMAC secret/version is configured;
- Turnstile site key, secret, hostname, and action are configured;
- every session/device/IP/subnet/global limit, window, queue depth/TTL, retention interval, and guest
  risk budget is a positive fail-closed value; any optional minimum queue delay is a nonnegative
  explicit value and defaults to zero;
- real billed Standard cost evidence is recorded and the runtime ceiling reflects it;
- a Provider-side hard spend limit and external spend alert have recorded operator evidence;
- storage, moderation, Outbox, Trigger tasks, watermark transform, cleanup, and alert destinations
  pass production readiness checks.
- the Privacy Policy and retention disclosures cover the temporary anonymous User/Session,
  up-to-24-hour guest media, promotion-period HMAC abuse evidence, account-link grant, and deletion
  process; the prior one-hour marketing-draft statement alone is insufficient.

Invalid production values reject startup/readiness or keep guest admission disabled. Development and
test defaults may use deterministic fakes, but no production fallback silently enables generation.

## Verification contract

Implementation follows genuine RED -> GREEN behavior tests. Required coverage includes:

- anonymous plugin schema/client wiring and registered-only procedure/layout denial;
- Better Auth wildcard-route default denial, gated/replayed anonymous bootstrap, direct
  `/api/auth/*` abuse cases, and temporary-user caps/cleanup;
- no welcome notification, Free monthly grant, organization, payment, settings, admin, History, or
  Edit Again access for an anonymous session;
- signed draft upload/promotion and all rejection paths producing zero Provider calls;
- Turnstile replay, spoofed proxy headers, cookie/device reset, IP/subnet/global bounds, queue full,
  and N/N+1 concurrent admissions;
- one atomic trial/grant/quote/job/reservation/input/Outbox result under replay and concurrency;
- projected-wait admission, delayed Outbox availability, FIFO dispatch, one global guest job,
  atomic Attempt/risk/kill-switch fencing, no guest retry/failover, and ten-minute expiry;
- uncertain submission preserving reservation and preventing a second attempt;
- deterministic watermarking, clean-stage deletion, guest-only signed access, and 24-hour cleanup;
- public UI empty/validating/waiting/delayed/ready/failed/expired states on desktop and mobile;
- keyboard, live-region, reduced-motion, 320 px reflow, explicit status navigation, three responsive
  layout bands, and no public Provider/model/cost strings;
- built marketing/SaaS artifacts containing no Raphael strings/assets/hotlinks and a matched-viewport
  originality review;
- registered generation, private History/Edit Again, credit, storage, moderation, recovery, and
  authenticated navigation regression coverage.

Provider, Stripe, Turnstile, and storage tests use deterministic adapters or task-owned local
services. They do not make paid external calls. Production enablement, deployment, and live billed
cost verification are separately reported and remain `NOT_COMPLETED` until performed.

## Migration and rollback

Migrations are additive: nullable/defaulted job and asset fields, the anonymous user flag, and new
guest records/indexes. Existing users become non-anonymous, existing jobs become `STANDARD`, and
existing assets retain the account policy. No historical job, asset, ledger, or audit evidence is
rewritten.

Rollback first disables the guest environment and database switches, drains or releases only
undispatched guest work, and lets accepted/uncertain attempts reconcile normally. The previous app
must continue reading defaulted schema fields. Ledger, trial, attempt, moderation, watermark, and
cleanup evidence is never deleted as a rollback shortcut.

## Explicit non-goals

- copying Raphael's trademarks, source, model catalog, promotional assets, exact styling, or
  contradictory claims;
- anonymous Quality Edit, video, text-to-image, multiple references, multiple outputs, clean
  originals, History, Edit Again, or commercial-rights entitlement;
- a parallel credit balance, queue, storage bucket, moderation service, Provider adapter, or direct
  Provider call;
- automatic transfer of an in-flight/completed guest job, sponsor credits, or result into registered
  History or Edit Again (the pre-admission draft transfer and expiry-bounded result read grant are
  the only transition capabilities);
- real Provider benchmarking, production guest enablement, deployment, or claims of live external
  certification in this implementation phase.
