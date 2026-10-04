import { VideoWorkspace } from "../../../../../modules/video-v1/VideoWorkspace";

export default async function VideoPage({
	searchParams,
}: {
	searchParams: Promise<{ job?: string | string[] }>;
}) {
	const { job } = await searchParams;
	const jobId = typeof job === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(job) ? job : null;
	return <VideoWorkspace initialJobId={jobId} />;
}
