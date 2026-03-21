import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { goal } = await req.json();
    if (!goal) return NextResponse.json({ error: "Goal is required" }, { status: 400 });

    // Mock Orchestrator logic
    // In a real scenario, we'd call an LLM with the goal and the list of available skills
    
    const lowerGoal = goal.toLowerCase();
    
    let suggestion = {
        projectName: "Mission: " + goal.substring(0, 30) + (goal.length > 30 ? "..." : ""),
        projectDescription: "Autonomous mission breakdown for: " + goal,
        tasks: [] as any[]
    };

    if (lowerGoal.includes("seo") || lowerGoal.includes("landing") || lowerGoal.includes("blog")) {
        suggestion.tasks = [
            { 
                title: "Audit Landing Page for SEO", 
                description: "Analyze the current landing page for meta-tags, keywords, and structural SEO improvements.", 
                agentRole: "SEO Specialist" 
            },
            { 
                title: "Competitor Content Analysis", 
                description: "Research top competitors and identify content gaps we can fill to outrank them.", 
                agentRole: "Market Researcher" 
            },
            { 
                title: "Draft Optimized Copy", 
                description: "Rewrite key sections of the landing page to optimize for conversions and SEO ranking.", 
                agentRole: "Copywriter" 
            }
        ];
    } else if (lowerGoal.includes("bug") || lowerGoal.includes("fix") || lowerGoal.includes("code")) {
        suggestion.tasks = [
            { 
                title: "Reproduction & Log Analysis", 
                description: "Attempt to reproduce reported issues and analyze system logs for anomalies.", 
                agentRole: "Debug Specialist" 
            },
            { 
                title: "Codebase Context Search", 
                description: "Search for related code patterns that might be causing the reported regression.", 
                agentRole: "Architect" 
            },
            { 
                title: "Submit Patch & Test", 
                description: "Develop a focused fix and verify it against the reproduction case.", 
                agentRole: "Bug Hunter" 
            }
        ];
    } else {
        suggestion.tasks = [
            { 
                title: "Initial Research & Strategy", 
                description: "Gather initial data and define the best path forward for the mission goal.", 
                agentRole: "Strategist" 
            },
            { 
                title: "Implementation Phase", 
                description: "Execute the primary steps required to achieve the goal based on research.", 
                agentRole: "Operator" 
            },
            { 
                title: "Final Review & Quality Assurance", 
                description: "Verify the results and ensure all project requirements are met.", 
                agentRole: "Verifier" 
            }
        ];
    }

    return NextResponse.json({ suggestion });
}
