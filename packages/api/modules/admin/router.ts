import { adminCapabilitiesRouter } from "../admin-agent/router";
import { findOrganization } from "./procedures/find-organization";
import { listOrganizations } from "./procedures/list-organizations";
import { listUsers } from "./procedures/list-users";

export const adminRouter = {
	capabilities: adminCapabilitiesRouter,
	users: {
		list: listUsers,
	},
	organizations: {
		list: listOrganizations,
		find: findOrganization,
	},
};
