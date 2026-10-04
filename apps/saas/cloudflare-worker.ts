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

import { forwardToWebsite } from "../web-host/src/forward";
// @ts-ignore OpenNext generates this module after Next's application type check.
import generatedWorker from "./.open-next/worker.js";
import { runScopedWorkerRequest, type WorkerExecutionContext } from "./cloudflare/request-scope";

interface WebsiteWorkerEnvironment {
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
		return forwardToWebsite(
			request,
			environment.CANONICAL_ORIGIN,
			async (forwardedRequest) => {
				if (!environment.HYPERDRIVE?.connectionString || !environment.IMAGES) {
					throw new Error("WEBSITE_WORKER_BINDINGS_REQUIRED");
				}
				const processor = createCloudflareImagesProcessor(environment.IMAGES);
				// Most requests (prefetches, public pages) never query the
				// database; allocate the client only on first actual access.
				const client = createLazyDatabaseClient(() =>
					createRuntimeDatabaseClient(environment.HYPERDRIVE.connectionString),
				);
				return runScopedWorkerRequest(
					forwardedRequest,
					environment,
					executionContext,
					{
						run: (callback) =>
							runWithDatabaseClient(client, () =>
								runWithImageProcessor(processor, () =>
									runWithCloudflareRemoteMedia(() =>
										environment.VIDEO_WORKFLOW
											? runWithVideoWorkflowBinding(environment.VIDEO_WORKFLOW, callback, {
													r2: Boolean(environment.VIDEO_MEDIA_BUCKET),
													hyperdrive: Boolean(environment.HYPERDRIVE?.connectionString),
													uploadCors: environment.VIDEO_V1_UPLOAD_CORS_READY === "true",
												})
											: callback(),
									),
								),
							),
						dispose: () => client.$disconnect(),
					},
					(request, environment, context) => openNextWorker.fetch(request, environment, context),
				);
			},
			environment.PAYMENT_WEBHOOK_INGRESS_ORIGIN,
		);
	},
};

// @ts-ignore OpenNext generates these cache Durable Object classes during the build.
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
