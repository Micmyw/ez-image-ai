import { EditVersionTimeline } from "@media/components/editor/EditVersionTimeline";

export default async function EditSessionPage({
	params,
}: {
	params: Promise<{ sessionId: string }>;
}) {
	const { sessionId } = await params;
	return <EditVersionTimeline sessionId={sessionId} />;
}
