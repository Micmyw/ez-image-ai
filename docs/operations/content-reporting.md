# Content reports and Waffo review

The individual operator confirmed the Waffo template response windows on September 16, 2026.
These are operator commitments, not an automated ticketing or notification service. Monitor the
existing `support@ezimageai.com` mailbox with coverage sufficient for the elapsed-hour deadlines,
including weekends. The reporting UI opens the user's email client; it does not submit a report
until the user sends the message. `noreply@ezimageai.com` is not a reporting channel.

## Public entry points

- `/terms`: the Acceptable Use Policy chapter, six prohibited categories, moderation, enforcement,
  four severity levels, handling deadlines, and appeals.
- `/contact#report-content`: no-login instructions and a mail link with subject `Content report`.
- Shared public footers: `Report content` links to the Contact section; the configured support
  email address is also visible directly as a `mailto:` link. Authentication and documentation
  footers show the same address with a localized support label.
- `/docs/privacy`: private-media reporting guidance; `/privacy` explains report data handling.

Source requirements: [Waffo AUP](https://docs.waffo.ai/zh/mor/account-reviews/aup) and
[AIGC content policy](https://docs.waffo.ai/zh/mor/account-reviews/aigc-compliance#content-policy-requirements).
The public policy uses the supported Terms chapter option rather than creating another route.

## Triage and deadlines

Deadlines start when the mailbox receives the report. Hours are elapsed hours, including weekends.
Business days are Monday through Friday in UTC.

| Level       | Examples                                                                         | First response  | Action completed |
| ----------- | -------------------------------------------------------------------------------- | --------------- | ---------------- |
| L1 critical | Child safety, terrorism, imminent serious harm                                   | 2 hours         | 24 hours         |
| L2 high     | Other serious violations, nonconsensual intimate deepfakes, severe targeted hate | 24 hours        | 3 business days  |
| L3 medium   | Other non-urgent policy or rights complaints                                     | 3 business days | 7 business days  |
| L4 low      | Minor violations or low-risk correction requests                                 | 5 business days | 15 business days |

1. Acknowledge the report manually, record receipt time and a reference, and assign a severity.
   Inspect content and circumstances rather than relying solely on the email subject.
2. Ask for missing descriptions or job/asset/public-page references as needed. Never request
   credentials, private signed URLs, or copies of suspected CSAM or other illegal material.
3. Review relevant private safety records through authorized operator access. Apply necessary
   protective restrictions promptly; do not wait for a final decision where protection is needed.
4. Record the evidence considered, decision, action, and timestamps privately. Restrict access
   to report correspondence and retain only what the investigation and legal obligations need.
5. Apply proportionate actions through existing account/media controls. Keep billing and ledger
   handling on their existing audited paths; do not arbitrarily zero a balance or mutate ledgers.
6. Reply with the outcome as privacy and law permit. If more time is needed, notify the reporter
   before the relevant deadline, explain why, and give an updated timeframe. Keep necessary
   protective restrictions in place. Refer suspected unlawful activity to competent authorities
   when required or permitted by law.

Use subject `URGENT content report` for critical reports. Appeals use `Content appeal` at the same
mailbox and receive an operator response within 10 business days. Reconsider the decision and
new evidence; do not represent the individual operator as an independent review team or claim
an automated acknowledgment, external audit, or continuously staffed team that does not exist.

## Verification and resubmission

Check that the published Terms and Contact page are accessible without authentication; the shared
footer opens the reporting section; and the email action addresses the correct mailbox with the
correct subject. Verify the six categories and all four deadline pairs in the rendered policy.
Do not send a test message without the operator's authorization.

Input/output safety controls remain documented in `sightengine-moderation.md` and production
prompt scanning in `waffo-prompt-moderation.md`. This content update does not change their policies,
call paid generation, or certify the live moderation services. Do not claim automated detection of
every infringement, lack of consent, or prohibited category.

After authorized publication and live checks, the operator can provide Waffo with the Terms and
Contact URLs and identify the added hate-speech prohibition, reporting instructions, and L1-L4
deadlines. Local changes alone do not update the public URLs, resubmit the merchant application,
or prove merchant approval.
