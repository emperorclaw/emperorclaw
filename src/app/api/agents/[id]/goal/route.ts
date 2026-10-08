import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/roles';
import { readAgentGoal, requestAgentGoal } from '@/lib/agent-goal';
type Params = { params: Promise<{id:string}> };
export async function GET(_req:NextRequest,{params}:Params){try{const ctx=await requireRole('member')();return NextResponse.json(await readAgentGoal(ctx.companyId,(await params).id,ctx.userId));}catch(e){return failure(e);}}
export async function POST(req:NextRequest,{params}:Params){try{const ctx=await requireRole('member')();return NextResponse.json(await requestAgentGoal(ctx.companyId,ctx.userId,(await params).id,await req.json()));}catch(e){return failure(e);}}
function failure(e:unknown){return NextResponse.json({error:e instanceof Error?e.message:'Objective request failed'},{status:e instanceof AuthError?e.statusCode:e instanceof Error&&e.message==='Agent not found'?404:400});}
