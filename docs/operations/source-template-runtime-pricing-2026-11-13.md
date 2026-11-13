# Published source materials and independent price display

## Behavior

Fixed source-template materials are imported and validated once at publication by
`applySourceTemplateProvisionBundle`. Access, quotation, transactional admission,
input review and provider submission consume the published immutable reference
snapshot without re-reading the material's asset row, administrator account,
moderation evidence or expiry. Historical reference metadata stays intact.
Runtime still reads the active versioned template provision; that configuration
read controls availability and prices, not repeated material approval.

Customer uploads retain ownership, immutable identity, moderation and retention
checks. Quote expiry, account credits, reservations, provider uncertainty and
idempotency are unchanged. Disable a provision to stop new orders; replacing
materials requires a new import/prepare/apply publication. Accepted orders keep
their original reference snapshots.

Source-template access returns published retail prices independently of generation
readiness. Ordinary-video selection likewise separates the displayed price from
whether generation is enabled. Independent video effects retain known complete
prices and the owner's credit balance when a runtime check fails. Internal-only
prices remain private. Missing or invalid pricing never produces a made-up charge
or an enabled Generate button. Prices requiring measured material duration still
need those pricing inputs; this change does not supply missing motion footage.

## Permanent material retention

The administrator importer reserves `users/<owner>/source-templates/<fingerprint>`
for fixed materials. These unbound INPUT records previously matched automatic
video orphan cleanup after 24 hours despite their permanent approval timestamp.
Candidate selection and the locked cleanup claim now exclude them, including
stale tombstoned candidates. The generic object-deletion consumer also retains
the reserved keys and their storage capacity when receiving older queued events.
Unrelated staging cleanup and ordinary user-input retention continue normally.

Retiring these immutable objects requires an explicit material operation after
checking accepted orders; ordinary retention does not delete them. The code
change cannot restore already deleted bytes. Production deletion has not been
established by the observed `VIDEO_SOURCE_TEMPLATE_REFERENCE_IDENTITY_CHANGED`
error, which covers multiple metadata/state failures.

## Verification and rollout boundary

Local regression checks cover unavailable-but-priced responses, ordinary-video
submission gating, frozen built-in references without database evidence reads,
publication validation, four-language button states and permanent-material
cleanup protection. Real PostgreSQL integration cases also cover the candidate
query and claim, plus provider submission after mutable reference-row changes;
they require an isolated running test database.

This is a local implementation, not a production release receipt. Deploy compatible
website and jobs/cleanup consumers together when authorized. A live verification
must check that the published object keys still exist, prices render for signed-in
users and ordinary user inputs remain gated. Do not infer successful generation
from an access response or a unit test. Rolling back to the old cleanup consumer
reintroduces automatic deletion risk for unbound fixed materials.
