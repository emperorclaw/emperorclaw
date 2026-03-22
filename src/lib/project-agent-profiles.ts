import { randomUUID } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { projectAgentProfiles } from "@/db/schema";

export async function listProjectAgentProfiles(companyId: string, projectId: string) {
  return db.select().from(projectAgentProfiles).where(and(
    eq(projectAgentProfiles.companyId, companyId),
    eq(projectAgentProfiles.projectId, projectId),
    isNull(projectAgentProfiles.deletedAt),
  )).orderBy(desc(projectAgentProfiles.updatedAt));
}

export async function getProjectAgentProfile(companyId: string, projectId: string, profileId: string) {
  const [profile] = await db.select().from(projectAgentProfiles).where(and(
    eq(projectAgentProfiles.companyId, companyId),
    eq(projectAgentProfiles.projectId, projectId),
    eq(projectAgentProfiles.id, profileId),
    isNull(projectAgentProfiles.deletedAt),
  )).limit(1);
  return profile || null;
}

export async function createProjectAgentProfile(input: {
  companyId: string;
  projectId: string;
  agentId: string;
  roleType?: string | null;
  displayName?: string | null;
  signature?: string | null;
  memorySeed?: string | null;
  resourcePolicyJson?: Record<string, unknown> | null;
}) {
  const [profile] = await db.insert(projectAgentProfiles).values({
    id: randomUUID(),
    companyId: input.companyId,
    projectId: input.projectId,
    agentId: input.agentId,
    roleType: input.roleType || "worker",
    displayName: input.displayName || null,
    signature: input.signature || null,
    memorySeed: input.memorySeed || null,
    resourcePolicyJson: input.resourcePolicyJson || {},
  }).returning();

  return profile;
}

export async function upsertProjectAgentProfile(input: {
  companyId: string;
  projectId: string;
  agentId: string;
  roleType?: string | null;
  displayName?: string | null;
  signature?: string | null;
  memorySeed?: string | null;
  resourcePolicyJson?: Record<string, unknown> | null;
}) {
  const [existing] = await db.select().from(projectAgentProfiles).where(and(
    eq(projectAgentProfiles.companyId, input.companyId),
    eq(projectAgentProfiles.projectId, input.projectId),
    eq(projectAgentProfiles.agentId, input.agentId),
    isNull(projectAgentProfiles.deletedAt),
  )).limit(1);

  if (!existing) {
    return createProjectAgentProfile(input);
  }

  const [profile] = await db.update(projectAgentProfiles).set({
    roleType: input.roleType ?? existing.roleType,
    displayName: input.displayName === undefined ? existing.displayName : input.displayName,
    signature: input.signature === undefined ? existing.signature : input.signature,
    memorySeed: input.memorySeed === undefined ? existing.memorySeed : input.memorySeed,
    resourcePolicyJson: input.resourcePolicyJson ?? existing.resourcePolicyJson,
    updatedAt: new Date(),
    deletedAt: null,
  }).where(eq(projectAgentProfiles.id, existing.id)).returning();

  return profile;
}

export async function updateProjectAgentProfile(input: {
  companyId: string;
  projectId: string;
  profileId: string;
  patch: Partial<{
    roleType: string;
    displayName: string | null;
    signature: string | null;
    memorySeed: string | null;
    resourcePolicyJson: Record<string, unknown>;
  }>;
}) {
  const existing = await getProjectAgentProfile(input.companyId, input.projectId, input.profileId);
  if (!existing) return null;

  const [profile] = await db.update(projectAgentProfiles).set({
    roleType: input.patch.roleType ?? existing.roleType,
    displayName: input.patch.displayName === undefined ? existing.displayName : input.patch.displayName,
    signature: input.patch.signature === undefined ? existing.signature : input.patch.signature,
    memorySeed: input.patch.memorySeed === undefined ? existing.memorySeed : input.patch.memorySeed,
    resourcePolicyJson: input.patch.resourcePolicyJson ?? existing.resourcePolicyJson,
    updatedAt: new Date(),
  }).where(eq(projectAgentProfiles.id, existing.id)).returning();

  return profile;
}

export async function archiveProjectAgentProfile(companyId: string, projectId: string, profileId: string) {
  const existing = await getProjectAgentProfile(companyId, projectId, profileId);
  if (!existing) return null;

  const [profile] = await db.update(projectAgentProfiles).set({
    deletedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(projectAgentProfiles.id, existing.id)).returning();

  return profile;
}
