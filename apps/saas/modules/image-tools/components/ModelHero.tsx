import { DisplayTitle } from "@repo/ui/components/display-title";

const presentations = {
	seedream: {
		label: "Seedream 5.5",
		lead: "See",
		accent: "dream",
		edition: "5.5",
		variant: "refract",
		eyebrow: "An image studio for your imagination",
		statement: ["Refine the details.", "Keep the feeling."],
	},
	minimax: {
		label: "MiniMax H3 Image",
		lead: "Mini",
		accent: "Max",
		edition: "H3",
		descriptor: "IMAGE",
		variant: "alloy",
		eyebrow: "Your ideas, rendered in detail",
		statement: ["Make every texture", "tell a story."],
	},
} as const;

export function ModelHero({
	model,
	intro,
	facts,
}: {
	model: keyof typeof presentations;
	intro: string;
	facts: readonly string[];
}) {
	const presentation = presentations[model];
	const { eyebrow, statement, ...title } = presentation;
	return (
		<header className="model-hero" data-model-hero={model}>
			<p className="model-hero-eyebrow">{eyebrow}</p>
			<DisplayTitle {...title} />
			<div className="model-hero-details">
				<p className="model-hero-statement">
					{statement[0]}
					<br /> {statement[1]}
				</p>
				<div className="model-hero-description">
					<p>{intro}</p>
					<ul aria-label="Tool features">
						{facts.map((fact) => (
							<li key={fact}>{fact}</li>
						))}
					</ul>
				</div>
			</div>
		</header>
	);
}
