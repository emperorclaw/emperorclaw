/**
 * The scene's English captions (src/lib/team-scene.ts deriveBehavior and
 * src/lib/live-office.ts deskStateLabel) mapped to their `scene.caption.*`
 * message keys. Those libraries also feed the desk display, so they keep
 * producing English; the web dashboard translates their output here.
 * tests/unit/i18n-parity.test.ts checks every English string below equals
 * its en.json value, so the two can never drift apart.
 */
export const SCENE_CAPTION_KEYS = {
    "Connection stale": "connectionStale",
    "Just finished": "justFinished",
    "Needs your approval": "needsYourApproval",
    "Awaiting agent response": "awaitingAgentResponse",
    "Needs a check-in": "needsCheckIn",
    "Approval pending": "approvalPending",
    "Work awaiting review": "workAwaitingReview",
    "Coffee break": "coffeeBreak",
    "Napping": "napping",
    "Stretching": "stretching",
    "Available": "available",
    "Task in progress": "taskInProgress",
    "In a huddle": "inHuddle",
    "Presenting": "presenting",
    "Reviewing": "reviewing",
    "Writing": "writing",
    "Researching": "researching",
    "Coding": "coding",
    "Working": "working",
    "Stuck": "stuck",
    "Working · needs you": "workingNeedsYou",
    "Needs you": "needsYou",
    "Blocked": "blocked",
    "In review": "inReview",
    "Idle": "idle",
    "Offline": "offline",
    "No recent connection with work waiting": "noRecentConnection",
    "Waiting for review": "waitingForReview",
    "Waiting for approval": "waitingForApproval",
    "Conversation paused": "conversationPaused",
    "Waiting on a decision": "waitingOnDecision",
    "Mentioned someone": "mentionedSomeone",
    "Last run failed": "lastRunFailed",
    "Task is blocked": "taskIsBlocked",
    "Request failed": "requestFailed",
    "No progress": "noProgress",
    "Running late": "runningLateShort",
    "Hasn't started": "hasNotStarted",
} as const;

export type SceneCaptionKey = (typeof SCENE_CAPTION_KEYS)[keyof typeof SCENE_CAPTION_KEYS];

/** Captions that carry a detail after a fixed English prefix ("Stuck: <reason>"). */
export const SCENE_CAPTION_PREFIXES = [
    { prefix: "Stuck: ", key: "stuckReason", arg: "reason" },
    { prefix: "Hasn't started ", key: "notStarted", arg: "task" },
    { prefix: "Running late on ", key: "runningLate", arg: "task" },
] as const;
