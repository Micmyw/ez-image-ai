import { listAdminContentCustomers, listAdminCustomerContent } from "@repo/database";
import { db } from "@repo/database/client";

import { adminProcedure } from "../../../orpc/procedures";
import {
	adminContentCustomersInputSchema,
	adminContentCustomersOutputSchema,
	adminCustomerContentInputSchema,
	adminCustomerContentOutputSchema,
} from "../admin-customer-content-types";

const privateAdmin = adminProcedure.use(({ context, next }) => {
	context.responseHeaders?.set("Cache-Control", "private, no-store");
	context.responseHeaders?.set("X-Robots-Tag", "noindex, nofollow");
	return next();
});
export const adminContentCustomers = privateAdmin
	.route({
		method: "POST",
		path: "/admin/media/customers/search",
		tags: ["Admin", "Media"],
		summary: "Find customers across images, jobs and blocked requests",
	})
	.input(adminContentCustomersInputSchema)
	.output(adminContentCustomersOutputSchema)
	.handler(({ input, context }) => listAdminContentCustomers(input, context.user.id, db));
export const adminCustomerContent = privateAdmin
	.route({
		method: "POST",
		path: "/admin/media/customers/content",
		tags: ["Admin", "Media"],
		summary: "Read one customer's paginated content timeline across all retained history",
	})
	.input(adminCustomerContentInputSchema)
	.output(adminCustomerContentOutputSchema)
	.handler(({ input, context }) => listAdminCustomerContent(input, context.user.id, db));
