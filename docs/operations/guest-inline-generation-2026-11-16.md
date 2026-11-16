# Guest generation in the current composer

The homepage and `/create` now complete an eligible uploaded-photo guest trial
from the original Generate click. Progress, the reviewed result and download
remain in the same composer location, without navigating through `/draft/continue`
and `/try` or requiring a second Generate click.

The existing handoff accepts explicit JSON requests: its POST sets the same
path-scoped HttpOnly cookies, the client bootstraps an anonymous session only if
needed, and GET claims the same draft through its existing owner check. These are
background requests, not document navigations. Unknown claims retain their
recovery cookies; account sessions and paid selections retain the account flow.

The embedded trial reuses the existing guest eligibility, submission, polling,
access and download implementation. Only the original click enables automatic
submission, once per mounted trial. A tab-local, non-secret recovery marker lets
refresh restore the existing server-owned result without automatically generating.
Concurrent submit calls share the existing attempt and cannot initiate two requests.

Region eligibility, lifetime trial limits, verification, private access, reviewed
provider-original visibility and settlement are unchanged. The old `/try` and
document handoff remain available for account linking and historical links.

This requires only a website deployment, with no migration or new feature switch.
Verification uses mocked local browser service boundaries for homepage and mobile
`/create`, including refreshed result recovery and exactly one generation request.
It does not establish a new live provider generation.
