import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { seeapiUpstream } from "./test-support/seeapi-workerd-upstream";

export default defineConfig({
	test: {
		projects: [
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.video.test.jsonc" },
						remoteBindings: false,
						miniflare: {
							outboundService: "video-seeapi-local-upstream",
							serviceBindings: { SEEAPI_UPSTREAM: "video-seeapi-local-upstream" },
							workers: [
								{
									name: "video-seeapi-local-upstream",
									modules: true,
									script: seeapiUpstream,
									compatibilityDate: "2026-09-10",
								},
							],
						},
					}),
				],
				test: {
					name: "video-seeapi-workerd",
					include: ["src/video-seeapi.workerd.test.ts"],
					testTimeout: 30_000,
				},
			},
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.video.test.jsonc" },
						remoteBindings: false,
						miniflare: {
							outboundService: "video-workflow-denied-upstream",

							workers: [
								{
									name: "video-workflow-denied-upstream",
									modules: true,
									script: `export default { fetch() { return new Response("Outbound fetch forbidden", { status: 502 }); } };`,
									compatibilityDate: "2026-09-10",
								},
							],
						},
					}),
				],
				test: {
					name: "video-workerd",
					include: ["src/video-generation-v1.workerd.test.ts"],
					testTimeout: 30_000,
				},
			},
			{
				test: {
					name: "unit",
					include: ["src/**/*.test.ts"],
					exclude: ["src/**/*.workerd.test.ts"],
				},
			},
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.test.jsonc" },
						remoteBindings: false,
					}),
				],
				test: { name: "workerd", include: ["src/workflow.workerd.test.ts"], testTimeout: 30_000 },
			},
			{
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.workers.test.jsonc" },
						remoteBindings: false,
						miniflare: {
							outboundService: "executor-denied-upstream",
							workers: [
								{
									name: "executor-denied-upstream",
									modules: true,
									script: `export default { fetch() { return new Response("Outbound fetch forbidden", { status: 502 }); } };`,
									compatibilityDate: "2026-09-10",
								},
							],
						},
					}),
				],
				test: {
					name: "worker-executor",
					include: ["src/executor.workerd.test.ts"],
					testTimeout: 30_000,
				},
			},
		],
	},
});
