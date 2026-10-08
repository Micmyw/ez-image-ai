import { hotelLobbyContent } from "../lib/content";

/** Server-rendered factual content stays readable without authentication or client-side RPC. */
export function VideoEffectArticle() {
	return (
		<article className="max-w-5xl space-y-12 px-4 py-12 sm:px-6 mx-auto">
			<section aria-labelledby="hotel-lobby-output" className="space-y-4">
				<h2 id="hotel-lobby-output" className="text-2xl font-semibold">
					What this template is designed to create
				</h2>
				<p className="leading-relaxed text-muted-foreground">
					Two adult photos become the left and right performers in one original orange studio scene
					with a suspended microphone. The five-second clip uses a short alternating performance
					with continuous framing. This beta is open to signed-in accounts. Facial similarity and
					movement can vary; verified public examples are not available yet.
				</p>
				<dl className="gap-4 p-5 sm:grid-cols-4 grid grid-cols-2 rounded-2xl border">
					{[
						["Duration", "5 seconds by default; 10 seconds optional"],
						["Picture", "720 × 1280 · 9:16"],
						["Format", "MP4"],
						["Sound", "No audio track"],
					].map(([label, value]) => (
						<div key={label}>
							<dt className="text-sm text-muted-foreground">{label}</dt>
							<dd className="mt-1 font-medium">{value}</dd>
						</div>
					))}
				</dl>
				<p className="text-sm text-muted-foreground">
					Silent video. Original song not included. Account sign-in is required before upload;
					availability and eligible credits are checked before an order can start.
				</p>
			</section>
			<section aria-labelledby="hotel-lobby-steps" className="space-y-5">
				<h2 id="hotel-lobby-steps" className="text-2xl font-semibold">
					How it works
				</h2>
				<ol className="gap-5 sm:grid-cols-2 grid">
					{hotelLobbyContent.steps.map((step, index) => (
						<li key={step.title} className="p-5 rounded-2xl border">
							<h3 className="font-semibold">
								{index + 1}. {step.title}
							</h3>
							<p className="mt-2 leading-relaxed text-muted-foreground">{step.body}</p>
						</li>
					))}
				</ol>
			</section>
			<section aria-labelledby="hotel-lobby-photos" className="space-y-4">
				<h2 id="hotel-lobby-photos" className="text-2xl font-semibold">
					Choosing your photos
				</h2>
				<p className="leading-relaxed text-muted-foreground">
					Use a clear, well-lit, mostly front-facing photo of one adult for each position. Keep
					faces visible and choose a crop with space around the head and shoulders. A blurred
					screenshot, face-covering accessory or heavily filtered portrait gives the generation less
					useful visual information. You must have permission to use both photos. These suggestions
					do not constitute an automated identity verification service.
				</p>
			</section>
			<section aria-labelledby="hotel-lobby-troubleshooting" className="space-y-4">
				<h2 id="hotel-lobby-troubleshooting" className="text-2xl font-semibold">
					Reviewing the result
				</h2>
				<p className="leading-relaxed text-muted-foreground">
					Check whether the people remain distinct, their left and right positions stay correct, and
					the short performance is readable. Watch for blended faces, extra people, sudden changes,
					heavy occlusion or gestures that barely move. Clearer reference photos may help, but
					changing the photos cannot guarantee a particular outcome. A new generation is a new order
					and requires its own displayed quote and confirmation.
				</p>
			</section>
			<section aria-labelledby="hotel-lobby-pricing-privacy" className="space-y-4">
				<h2 id="hotel-lobby-pricing-privacy" className="text-2xl font-semibold">
					Pricing and privacy
				</h2>
				<p className="leading-relaxed text-muted-foreground">
					The template uses your existing EzImageAI account and eligible credits. Its quote covers
					the complete scene-to-video order. The internal scene image is not a second retail
					purchase, and repeat playback or downloads do not generate a new charge. If an order needs
					review, its reserved credits can remain on hold until the outcome is known.
				</p>
				<p className="leading-relaxed text-muted-foreground">
					Uploaded photos, the internal scene and generated results remain private. Public sample
					videos require separate authorization and independently published copies. Store any
					completed videos you want to keep: access follows the existing account retention policy.
					See the{" "}
					<a className="underline underline-offset-4" href="/docs/privacy">
						privacy guide
					</a>{" "}
					and{" "}
					<a className="underline underline-offset-4" href="/docs/credits">
						credit guide
					</a>{" "}
					for the account rules.
				</p>
			</section>
			<section aria-labelledby="hotel-lobby-faq" className="space-y-5">
				<h2 id="hotel-lobby-faq" className="text-2xl font-semibold">
					Frequently asked questions
				</h2>
				<div className="px-5 divide-y rounded-2xl border">
					{hotelLobbyContent.faq.map((item) => (
						<details key={item.question} className="py-4">
							<summary className="font-medium cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
								{item.question}
							</summary>
							<p className="mt-3 leading-relaxed text-muted-foreground">{item.answer}</p>
						</details>
					))}
				</div>
			</section>
		</article>
	);
}
