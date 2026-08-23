"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ChevronDownIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib";

const Accordion = AccordionPrimitive.Root;

const AccordionItem = ({
	className,
	...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) => (
	<AccordionPrimitive.Item className={cn("border-b", className)} {...props} />
);

const AccordionTrigger = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) => (
	<AccordionPrimitive.Header className="flex">
		<AccordionPrimitive.Trigger
			className={cn(
				"py-4 font-medium text-sm flex flex-1 items-center justify-between transition-all hover:underline [&[data-panel-open]>svg]:rotate-180",
				className,
			)}
			{...props}
		>
			{children}
			<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
		</AccordionPrimitive.Trigger>
	</AccordionPrimitive.Header>
);

const AccordionContent = ({
	className,
	children,
	...props
}: React.ComponentProps<typeof AccordionPrimitive.Panel>) => (
	<AccordionPrimitive.Panel
		className={cn(
			"text-sm overflow-hidden data-[ending-style]:animate-accordion-up data-[starting-style]:animate-accordion-down",
			className,
		)}
		{...props}
	>
		<div className="pt-0 pb-4">{children}</div>
	</AccordionPrimitive.Panel>
);

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
