import { NextRequest, NextResponse } from 'next/server';
import { requireRole, AuthError } from '@/lib/roles';
import { readAgentObjective, requestAgentObjective } from '@/lib/agent-objective';
import { memberMaySeeAgent } from '@/lib/member-scope';
type Params = { params: Promise<{id:string}> };
export async function GET(_req:NextRequest,{params}:Params){try{const ctx=await requireRole('member')();const id=(await params).id;if(!memberMaySeeAgent(ctx.scope,id))throw new Error('Agent not found');return NextResponse.json(await readAgentObjective(ctx.companyId,id,ctx.userId));}catch(e){return failure(e);}}
export async function POST(req:NextRequest,{params}:Params){try{const ctx=await requireRole('member')();const id=(await params).id;if(!memberMaySeeAgent(ctx.scope,id))throw new Error('Agent not found');return NextResponse.json(await requestAgentObjective(ctx.companyId,ctx.userId,id,await req.json()));}catch(e){return failure(e);}}
function failure(e:unknown){return NextResponse.json({error:e instanceof Error?e.message:'Objective request failed'},{status:e instanceof AuthError?e.statusCode:e instanceof Error&&e.message==='Agent not found'?404:e instanceof Error&&e.message==='Objective not found'?404:400});}
