import Link from "next/link";
import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, companyMembers, incidents, notifications, projects, tasks, threadParticipants, users } from "@/db/schema";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { computeCompanyHealth, type HealthStatus, type AgentHealth } from "@/lib/agent-health";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "@/lib/task-state";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";

export const dynamic = "force-dynamic";
