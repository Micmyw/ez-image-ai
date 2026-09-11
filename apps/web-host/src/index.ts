import { Container, getContainer } from "@cloudflare/containers";

import { forwardToWebsite, websiteEnvironment } from "./forward";

export class SaasContainer extends Container<Cloudflare.Env> {
	defaultPort = 8080;
	sleepAfter = "5m";
	enableInternet = true;
	envVars = websiteEnvironment(this.env.WEB_RUNTIME_ENV, this.env.CANONICAL_ORIGIN);
}

export default {
	fetch(request, env) {
		return forwardToWebsite(request, env.CANONICAL_ORIGIN, (forwarded) =>
			getContainer(env.SAAS, "website-primary").fetch(forwarded),
		);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
