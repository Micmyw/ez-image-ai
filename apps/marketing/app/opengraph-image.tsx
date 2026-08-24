import { config } from "@config";
import { ImageResponse } from "next/og";

export const alt = `${config.appName} AI image editor`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
	return new ImageResponse(
		<div
			style={{
				alignItems: "center",
				background: "linear-gradient(135deg, #f4f1ff 0%, #ffffff 52%, #e8f8ff 100%)",
				color: "#19162c",
				display: "flex",
				height: "100%",
				justifyContent: "center",
				width: "100%",
			}}
		>
			<div style={{ alignItems: "center", display: "flex", flexDirection: "column" }}>
				<div
					style={{
						alignItems: "center",
						background: "#6d5dfc",
						borderRadius: 32,
						color: "white",
						display: "flex",
						fontSize: 56,
						height: 128,
						justifyContent: "center",
						width: 128,
					}}
				>
					E
				</div>
				<div style={{ fontSize: 82, fontWeight: 700, marginTop: 30 }}>{config.appName}</div>
				<div style={{ color: "#5b5670", fontSize: 34, marginTop: 14 }}>
					AI image editing, from prompt to polished result
				</div>
			</div>
		</div>,
		{ ...size },
	);
}
