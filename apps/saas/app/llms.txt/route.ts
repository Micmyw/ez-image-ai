import { buildLlmsText } from "./llms-text";

export const revalidate = false;

export function GET() {
	return new Response(buildLlmsText(), {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
