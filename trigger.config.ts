import { prismaExtension } from "@trigger.dev/build/extensions/prisma";
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
	project: process.env.TRIGGER_PROJECT_REF ?? "set-trigger-project-ref",
	maxDuration: 900,
	dirs: ["./packages/jobs/trigger"],
	build: {
		extensions: [prismaExtension({ mode: "modern" })],
	},
});
