import { test } from "node:test";
import assert from "node:assert/strict";
import {
    customAccessSummary, effectiveResourceRole, mayGrantResourceRole, mayManageResourceAccess, maxRole,
    resourceRoleAsRole, roleAsResourceRole, type MembershipFact, type ResourceFacts,
} from "../../src/lib/resource-roles";
import type { Role } from "../../src/lib/role-matrix";

const HARBOR = "customer-harbor";
const OTHER_CUSTOMER = "customer-other";
const SITE = "project-site"; // a Harbor Dental project
const ADS = "project-ads"; // another Harbor Dental project
const INTERNAL = "project-internal"; // no customer

const customer: ResourceFacts = { type: "customer", id: HARBOR };
const site: ResourceFacts = { type: "project", id: SITE, customerId: HARBOR };
const ads: ResourceFacts = { type: "project", id: ADS, customerId: HARBOR };
const internal: ResourceFacts = { type: "project", id: INTERNAL, customerId: null };
const otherCustomer: ResourceFacts = { type: "customer", id: OTHER_CUSTOMER };

const on = (resourceType: "customer" | "project", resourceId: string, role: string): MembershipFact => ({ resourceType, resourceId, role });

test("editor counts as member, viewer as viewer, admin as admin", () => {
    assert.equal(resourceRoleAsRole("admin"), "admin");
    assert.equal(resourceRoleAsRole("editor"), "member");
    assert.equal(resourceRoleAsRole("viewer"), "viewer");
    assert.equal(roleAsResourceRole("owner"), "admin");
    assert.equal(roleAsResourceRole("instance_admin"), "admin");
    assert.equal(roleAsResourceRole("member"), "editor");
    assert.equal(roleAsResourceRole("viewer"), "viewer");
    assert.equal(maxRole(["viewer", "admin", "member"]), "admin");
    assert.equal(maxRole([]), null);
});

test("roleFor matrix: company role x membership x resource (unrestricted members)", () => {
    const cases: { company: Role; memberships: MembershipFact[]; resource: ResourceFacts; expected: Role | null; why: string }[] = [
        // Nothing custom: the company role everywhere.
        { company: "viewer", memberships: [], resource: site, expected: "viewer", why: "viewer, no membership" },
        { company: "member", memberships: [], resource: customer, expected: "member", why: "member, no membership" },
        { company: "admin", memberships: [], resource: internal, expected: "admin", why: "admin, no membership" },
        { company: "owner", memberships: [on("project", SITE, "viewer")], resource: site, expected: "owner", why: "a membership never lowers" },
        // Elevation inside the resource only.
        { company: "viewer", memberships: [on("project", SITE, "editor")], resource: site, expected: "member", why: "project editor edits the project" },
        { company: "viewer", memberships: [on("project", SITE, "editor")], resource: ads, expected: "viewer", why: "...and not the sibling project" },
        { company: "viewer", memberships: [on("project", SITE, "editor")], resource: customer, expected: "viewer", why: "...nor its customer" },
        { company: "viewer", memberships: [on("customer", HARBOR, "admin")], resource: customer, expected: "admin", why: "customer admin" },
        { company: "viewer", memberships: [on("customer", HARBOR, "admin")], resource: ads, expected: "admin", why: "a project inherits its customer's role" },
        { company: "viewer", memberships: [on("customer", HARBOR, "admin")], resource: otherCustomer, expected: "viewer", why: "only inside Harbor Dental" },
        { company: "viewer", memberships: [on("customer", HARBOR, "admin")], resource: internal, expected: "viewer", why: "internal projects are not under it" },
        { company: "viewer", memberships: [on("customer", HARBOR, "viewer"), on("project", SITE, "editor")], resource: site, expected: "member", why: "max of project and customer" },
        { company: "member", memberships: [on("customer", HARBOR, "viewer")], resource: site, expected: "member", why: "max with the company role" },
        { company: "viewer", memberships: [on("customer", HARBOR, "bogus")], resource: site, expected: "viewer", why: "an unknown stored role grants nothing" },
    ];
    for (const c of cases) {
        assert.equal(effectiveResourceRole({ companyRole: c.company, restricted: false, memberships: c.memberships, resource: c.resource }), c.expected, c.why);
    }
});

test("roleFor: a restricted member sees only what they hold a membership for", () => {
    const restricted = (company: Role, memberships: MembershipFact[], resource: ResourceFacts) =>
        effectiveResourceRole({ companyRole: company, restricted: true, memberships, resource });
    assert.equal(restricted("member", [], site), null, "no membership: invisible");
    assert.equal(restricted("member", [on("customer", HARBOR, "editor")], site), "member", "customer membership opens its projects");
    assert.equal(restricted("member", [on("customer", HARBOR, "editor")], internal), null, "internal projects stay hidden");
    assert.equal(restricted("viewer", [on("project", SITE, "viewer")], site), "viewer");
    assert.equal(restricted("viewer", [on("project", SITE, "viewer")], customer), null, "a project grant does not open the customer");
    assert.equal(restricted("viewer", [on("project", SITE, "admin")], site), "admin", "elevates inside the project");
    assert.equal(restricted("viewer", [on("project", INTERNAL, "editor")], internal), "member", "an internal project can be granted directly");
    // Migration 0072 maps member -> editor and viewer -> viewer, so the role is unchanged.
    assert.equal(restricted("member", [on("customer", HARBOR, "editor")], customer), "member");
    assert.equal(restricted("viewer", [on("customer", HARBOR, "viewer")], customer), "viewer");
    // The membership role is the whole answer: "Can view" is read-only even for a company member or admin-ish role.
    assert.equal(restricted("member", [on("project", SITE, "viewer")], site), "viewer", "Can view stays read-only");
    assert.equal(restricted("member", [on("customer", HARBOR, "viewer"), on("project", SITE, "editor")], site), "member", "max of the memberships");
    assert.equal(restricted("member", [on("customer", HARBOR, "viewer"), on("project", SITE, "editor")], ads), "viewer", "the sibling keeps the customer's role");
});

test("managing Access: admins on the resource, never above their own role", () => {
    assert.equal(mayManageResourceAccess("admin"), true);
    assert.equal(mayManageResourceAccess("owner"), true);
    assert.equal(mayManageResourceAccess("member"), false, "editors cannot change access");
    assert.equal(mayManageResourceAccess(null), false);
    assert.equal(mayGrantResourceRole("admin", "admin"), true);
    assert.equal(mayGrantResourceRole("admin", "editor"), true);
    assert.equal(mayGrantResourceRole("member", "viewer"), false, "an editor grants nothing");
    assert.equal(mayGrantResourceRole("viewer", "viewer"), false);
});

test("custom access summary for the members page", () => {
    assert.equal(customAccessSummary([{ name: "Harbor Dental", role: "editor" }]), "Harbor Dental · Can edit");
    assert.equal(customAccessSummary([{ name: "A", role: "admin" }, { name: "B", role: "viewer" }]), "A · Admin, B · Can view");
    assert.equal(customAccessSummary([]), "");
});
