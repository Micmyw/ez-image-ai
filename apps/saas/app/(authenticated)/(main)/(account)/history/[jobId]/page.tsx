import { JobDetail } from "@media/components/JobDetail";

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
	const { jobId } = await params;
	return <JobDetail jobId={jobId} />;
}
