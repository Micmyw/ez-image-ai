"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";

const DialogContent = dynamic(() =>
	import("./PaidTemplateDialogContent").then((module) => module.PaidTemplateDialogContent),
);

export function PaidTemplateDialog(props: ComponentProps<typeof DialogContent>) {
	return props.open ? <DialogContent {...props} /> : null;
}
