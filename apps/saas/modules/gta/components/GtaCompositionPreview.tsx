import Image from "next/image";

import { GTA_SCENES, gtaAspectRatio, type GtaIntent, type GtaSettings } from "../lib/config";
import { GTA_EXAMPLES } from "../lib/examples";

/** A labeled layout guide, not a downloadable substitute for generated artwork. */
export function GtaCompositionPreview({
	intent,
	settings,
}: {
	intent: GtaIntent;
	settings: GtaSettings;
}) {
	const scene = GTA_SCENES.find((item) => item.id === settings.sceneId)!;
	const background = GTA_EXAMPLES.find((item) => item.sceneId === scene.id && !item.sourceSrc)!;
	const portrait =
		intent === "loading-art" ? settings.position : settings.format === "phone" ? "center" : "right";
	return (
		<div
			className="gta-composition-guide"
			data-format={settings.format}
			data-portrait={portrait}
			data-intent={intent}
		>
			<div
				className="gta-composition-frame"
				style={{ aspectRatio: settings.format === "phone" ? "9/16" : "16/9" }}
			>
				<Image src={background.src} alt="" fill sizes="(max-width: 760px) 80vw, 440px" />
				{settings.sourceMode === "photo" && (
					<div className="gta-composition-person">
						<span>Your portrait</span>
					</div>
				)}
				<div className="gta-composition-space">
					{intent === "loading-art"
						? "Name area"
						: settings.format === "phone"
							? "Clock space"
							: "Icon space"}
				</div>
			</div>
			<p>
				<strong>Composition guide</strong> · {scene.name} · {gtaAspectRatio(settings.format)}
			</p>
		</div>
	);
}
