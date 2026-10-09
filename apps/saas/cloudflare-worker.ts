import { hydrateVideoRuntimeEnvironment } from "@repo/config/video-runtime-environment";
import {
	createLazyDatabaseClient,
	createRuntimeDatabaseClient,
	runWithDatabaseClient,
} from "@repo/database/client";
import type { VideoWorkflowBinding } from "@repo/jobs/video-v1/contracts";
import { runWithVideoWorkflowBinding } from "@repo/jobs/video-v1/workflow-binding";
import {
	createCloudflareImagesProcessor,
	type CloudflareImagesBinding,
} from "@repo/storage/image-processing/cloudflare-images";
import { runWithImageProcessor } from "@repo/storage/image-processing/context";
import { runWithCloudflareRemoteMedia } from "@repo/storage/lib/cloudflare-remote-media";
import { runWithRequestDefer } from "@repo/utils/request-lifecycle";

import { forwardToWebsite } from "../web-host/src/forward";
// @ts-ignore OpenNext generates this module after Next's application type check.
import generatedWorker from "./.open-next/worker.js";
import { runScopedWorkerRequest, type WorkerExecutionContext } from "./cloudflare/request-scope";

interface WebsiteWorkerEnvironment {
	VIDEO_RUNTIME_CONFIG?: string;
	VIDEO_V1_ENABLED?: string;
	CANONICAL_ORIGIN: string;
	PAYMENT_WEBHOOK_INGRESS_ORIGIN?: string;
	HYPERDRIVE: { connectionString: string };
	IMAGES: CloudflareImagesBinding;
	VIDEO_WORKFLOW?: VideoWorkflowBinding;
	VIDEO_MEDIA_BUCKET?: unknown;
	VIDEO_V1_UPLOAD_CORS_READY?: string;
}

const openNextWorker = generatedWorker as {
	fetch(
		request: Request,
		environment: WebsiteWorkerEnvironment,
		executionContext: WorkerExecutionContext,
	): Promise<Response>;
};

export default {
	fetch(
		request: Request,
		environment: WebsiteWorkerEnvironment,
		executionContext: WorkerExecutionContext,
	): Promise<Response> {
		const runtimeEnvironment = hydrateVideoRuntimeEnvironment(environment);
		return forwardToWebsite(
			request,
			runtimeEnvironment.CANONICAL_ORIGIN,
			async (forwardedRequest) => {
				if (!runtimeEnvironment.HYPERDRIVE?.connectionString || !runtimeEnvironment.IMAGES) {
					throw new Error("WEBSITE_WORKER_BINDINGS_REQUIRED");
				}
				const processor = createCloudflareImagesProcessor(runtimeEnvironment.IMAGES);
				// Most requests (prefetches, public pages) never query the
				// database; allocate the client only on first actual access.
				const client = createLazyDatabaseClient(() =>
					createRuntimeDatabaseClient(runtimeEnvironment.HYPERDRIVE.connectionString),
				);
				return runScopedWorkerRequest(
					forwardedRequest,
					runtimeEnvironment,
					executionContext,
					{
						run: (callback) =>
							runWithDatabaseClient(client, () =>
								runWithImageProcessor(processor, () =>
									runWithCloudflareRemoteMedia(() =>
										runtimeEnvironment.VIDEO_WORKFLOW
											? runWithVideoWorkflowBinding(runtimeEnvironment.VIDEO_WORKFLOW, callback, {
													r2: Boolean(runtimeEnvironment.VIDEO_MEDIA_BUCKET),
													hyperdrive: Boolean(runtimeEnvironment.HYPERDRIVE?.connectionString),
													uploadCors: runtimeEnvironment.VIDEO_V1_UPLOAD_CORS_READY === "true",
												})
											: callback(),
									),
								),
							),
						dispose: () => client.$disconnect(),
					},
					(request, environment, context) =>
						// This is runScopedWorkerRequest's proxy, which keeps DB scope alive.
						runWithRequestDefer(
							(task) => context.waitUntil(task),
							() => openNextWorker.fetch(request, environment, context),
						),
				);
			},
			runtimeEnvironment.PAYMENT_WEBHOOK_INGRESS_ORIGIN,
		);
	},
};

// @ts-ignore OpenNext generates these cache Durable Object classes during the build.
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
