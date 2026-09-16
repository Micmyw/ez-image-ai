// Reserve the conventional filename so it cannot match an organization slug.
export function GET() {
	return new Response("Not Found", {
		status: 404,
		headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" },
	});
}
