import { deploymentRelease, sentryBeforeSend } from "@repo/logs/sentry";
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN;

if (dsn && process.env.ERROR_MONITORING_ENABLED === "true") {
	Sentry.init({
		dsn,
		enabled: true,
		release: deploymentRelease(),
		beforeSend: (event) => sentryBeforeSend(event),
		sendDefaultPii: false,
		tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
	});
}
