# Hotel Lobby private build overlay

`HOTEL_LOBBY_DUO_RUNTIME_CONFIG` is a private **build-only** JSON patch. It is not a
second Worker runtime policy. The website and background build runners merge it
with their existing private `VIDEO_RUNTIME_CONFIG`, validate the result, and ship
one private `VIDEO_RUNTIME_CONFIG` to each Worker. Do not replace an unreadable
production policy with a local environment snapshot.

The patch permits only Hotel Lobby access, price, cost and accepted-template-version
fields. It rejects credentials, admission/build switches, both funding policies,
and every ordinary `VIDEO_*` field. Existing internal users, funding, ordinary
prices and allowed model groups remain unchanged. The builder adds only the fixed
Seedance 1.5 Pro image-to-video / 5 seconds / 720p / silent tuple when absent. It
never widens the arrays in an existing group. That shared tuple is also available
to users already eligible for ordinary video; `VIDEO_V1_ACCESS` stays `internal`.

`HOTEL_LOBBY_DUO_ACCESS=authenticated` permits authenticated, non-anonymous
accounts through the template's own access policy. Missing access defaults to
`internal`; malformed values fail closed. Paid credit qualification, media/video
kill switches, safety, prices and provider readiness still apply.

## Prepare without copying a production policy

Run from the repository root:

```sh
pnpm hotel-lobby:prepare-config --input docs/operations/hotel-lobby-configuration.example.env --build-overlay --access authenticated
```

The ignored output is `.wrangler/hotel-lobby/prepared/build-overlay.env`. Existing
files are never overwritten; use `--output <new-ignored-path>` for another run.
It contains only the narrow patch and `HOTEL_LOBBY_DUO_BUILD_ENABLED=false`.
The local reference calculation is 69 credits under the assumptions recorded in
[the price receipt](hotel-lobby-pricing-2026-10-05.md). Its budgets are not supplier
invoices, and the build validates against its current inherited policy again.

The tool never invents quality evidence or adds funding. It copies an explicit
accepted-template version only when present in its input; the default closed
reference does not supply one. For the owner-authorized public beta, that exact
version records the deployment policy approval, not proven output quality.
Opening the template requires the approved
version, complete current cost evidence, an unexpired price, and the separate
`HOTEL_LOBBY_DUO_BUILD_ENABLED=true` control. A partial access-only patch cannot
open an unconfigured template.

## Authorized deployment procedure

1. Confirm both the website and jobs build targets already have their current
   private `VIDEO_RUNTIME_CONFIG`. Its value need not be retrieved locally. An
   empty, malformed or absent base stops the patch; a Worker runtime secret alone
   cannot substitute for the build runner's private base.
2. Update only the private `HOTEL_LOBBY_DUO_RUNTIME_CONFIG` build variable on both
   targets using the approved patch. Preserve the existing `VIDEO_RUNTIME_CONFIG`,
   `VIDEO_V1_BUILD_ENABLED`, credentials, ordinary access and funding values.
   Transfer secret values through a protected tool/stdin, never command arguments
   or logs.
3. Keep the website's `HOTEL_LOBBY_DUO_BUILD_ENABLED=false` during the first
   deployment. For the owner-authorized public beta, enable the background target
   first and verify its new Workflow deployment. Only then set the website's
   dedicated build variable to `true` and deploy it. This prevents new admissions
   from reaching an old background handler. The builder checks the complete
   merged quote before accepting either enabled target.
4. Verify the existing Nano Banana 2 Lite image flag and Kie provider eligibility
   separately. This overlay deliberately cannot change image-provider policy or
   credentials. Verify both workers deploy the intended code/version and the same
   approved template policy. Local preparation and successful builds do not prove
   account model entitlement, paid generation, callbacks or live delivery.

The overlay and build switch are stripped from runtime artifacts and build child
environments. Access, allowlists and costs stay in the private runtime pack and
are absent from public variables. Each resulting pack must remain within 5,000
UTF-8 bytes; overflow stops the build without deleting existing fields.

## Close and roll back

Set `HOTEL_LOBBY_DUO_BUILD_ENABLED=false` on both build targets and deploy through
the existing release process to stop new template orders. Preserve the current
private policy, callbacks, Workflow code and assets while accepted orders drain.
Do not change ordinary video access or funding to close this template.

For a policy rollback, restore the prior narrow overlay or remove it and redeploy
with the template closed. The original private base build variable was never
overwritten, so removing the overlay restores that base. Continue using the
[video drain and rollback procedure](video-v1-rollout.md) for accepted work; do not
resubmit uncertain paid requests.
