# Tesco source check

Checked on 2026-10-11 against [Tesco PLC's Interim Results 2026/27](https://www.tescoplc.com/interim-results-202627/), published 2026-10-08.

The successful `web.search_query` request used:

```json
{
	"q": "Tesco Interim Results 2026/27 8 October AI-powered meal planning assistant",
	"domains": ["tescoplc.com"]
}
```

The response returned the complete official page under reference `turn6search0`; its displayed URL was the source URL above. The page's section “Connected, personalised and loved by customers” contained this 18-word excerpt:

> Launched AI-powered meal planning assistant in April, trialling with c.280,000 colleagues before starting wider customer rollout in September

A separate bullet placed Your Clubcard Prices at approximately 2.5 million customers. The article keeps that number separate from meal-assistant availability.

Direct `web.open`/`web.find` returned no page text, and a read-only PowerShell fetch returned Akamai Access Denied. The successful search response, rather than those empty/error responses, was used for factual verification. No signed-in Tesco account or live assistant entry point was tested.
