// Secrets supplied separately by Wrangler. Binding/runtime types are generated.
declare namespace Cloudflare {
	interface Env {
		WORKFLOWS_DISPATCH_SECRET: string;
		WORKFLOWS_DISPATCH_URL: string;
		JOBS_RUNTIME_ENV: string;
	}
}
