# Video UI follow-up evidence

These are **local UI fixtures**, captured on 2026-10-04. The browser used a real local Better Auth
session and the isolated PostgreSQL test database. Video catalog, quote, upload completion, job,
and playback responses were intercepted by the Playwright fixture. The displayed **23 credits**
is fixture data, not an approved production price. No supplier generation or production release
is demonstrated by these screenshots.

- `desktop-model-families-fixture.png`: 1440px view, model menu grouped by family, unavailable
  variants disabled. The menu scrolls when all entries cannot fit.
- `desktop-video-settings-fixture.png`: selected Seedance tuple, duration/resolution/frame/audio
  panel, and explicit paid-credit confirmation. Finite popup animations were completed for capture.
- `mobile-video-settings-fixture.png`: 390px image-mode panel, reference framing without an
  unsupported independent ratio control, secured-upload status distinct from content approval.
- `video-ui-browser-report.json`: final uninterrupted **9 passed, 0 failed, 0 skipped** browser run.

Command: `node tests/video-v1/local-command.mjs e2e:media:video-ui`, with an explicit isolated
loopback `VIDEO_VERIFICATION_DATABASE_URL`. The guarded runner blocks non-local service traffic
apart from public font reads, seeds deterministic local accounts, and starts/stops its own Next
server. The browser fixture blocks all non-loopback traffic.

The nine cases cover refresh/closed-page recovery, private playback authorization, exact lost-response
retry, model/attribute quote invalidation and complete receipt restoration, audio readiness gating,
single-image sealing on mobile, disabled intake with readable history, rejection/credit release,
insufficient paid credits/expired quotes, and uncertain provider acceptance with visibility-aware
status polling. Some cases cover multiple behaviors.

Real provider/model access, real output dimensions and audio, external moderation, Workflow execution,
R2 delivery, and paid generation acceptance remain **NOT_RUN/BLOCKED** by their external conditions.
Production was **not deployed or opened** by this UI verification.
