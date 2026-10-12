#include "demo_data.h"

// Scripted demo company (feed v2): every agent has a web-style look, acts out its work,
// and thinks out loud. A handoff flies every ~8 s, a task finishes every ~15 s, someone
// needs you every ~45 s (and is answered ~18 s later), someone gets blocked every ~33 s,
// and agents go down and come back. Random state changes and chat fill the gaps, so
// every visual shows up within the first 15 seconds.

namespace {

struct DemoAgent {
  const char* id;
  const char* name;
  const char* shortName;
  Look look;
  const char* activities[4];
  const char* tasks[3];
  const char* thoughts[3];
};

const DemoAgent kAgents[] = {
    {"demo-ada", "Ada Researcher", "Ada", {212, LOOK_HUMAN, 0, 1, 0, 1, ACC_GLASSES},
     {"Reading the Q3 market report", "Comparing three competitor pricing pages", "Summarizing customer interviews",
      "Collecting sources on AI regulation"},
     {"Draft Q3 summary", "Competitor pricing scan", "Interview synthesis"},
     {"The Q3 numbers disagree with the board deck. Checking which source finance used before I flag it.",
      "Three of five competitors dropped their free tier this month. That is a pattern, not noise.",
      "Interview 4 and 7 both mention onboarding friction. Pulling exact quotes for the summary."}},
    {"demo-max", "Max Builder", "Max", {28, LOOK_ROBOT, 2, 0, 0, 0, ACC_HEADSET},
     {"Refactoring the billing webhook", "Running the integration test suite", "Fixing a flaky login test",
      "Reviewing pull request 482"},
     {"Ship invoice export", "Fix flaky auth test", "Upgrade database driver"},
     {"Webhook retries look idempotent, but the refund path writes twice. Adding a guard and a test first.",
      "The flaky test only fails after midnight UTC. Timezone bug in the fixture, not in the login code.",
      "PR 482 is fine except one N+1 query in the invoice list. Suggesting a join instead."}},
    {"demo-luna", "Luna Designer", "Luna", {300, LOOK_HUMAN, 1, 3, 3, 3, ACC_BOW},
     {"Sketching the onboarding flow", "Polishing icon set for dark mode", "Exporting hero images",
      "Tuning the brand color tokens"},
     {"Onboarding redesign", "Dark mode icons", "Landing hero art"},
     {"Step 3 of onboarding asks for billing too early. Moving it after the first success moment.",
      "The violet fails contrast on dark backgrounds. Nudging it two steps lighter.",
      "Hero art reads better with one character, not three. Less is more at phone size."}},
    {"demo-rex", "Rex Ops", "Rex", {140, LOOK_ROBOT, 1, 0, 0, 0, ACC_NONE},
     {"Rotating TLS certificates", "Watching the deploy pipeline", "Tuning database backups",
      "Checking error budgets"},
     {"Nightly backup audit", "Deploy v0.9 to prod", "Alert noise cleanup"},
     {"Backups finish in 41 minutes now. Restore test next, a backup nobody restored is a wish.",
      "Error budget is at 92 percent. Safe to ship the deploy before the weekend freeze.",
      "Half of last week's alerts were the same disk warning. Raising the threshold, keeping the page."}},
    {"demo-iris", "Iris Analyst", "Iris", {180, LOOK_HUMAN, 2, 4, 5, 5, ACC_NONE},
     {"Building the weekly KPI dashboard", "Cleaning churn data", "Forecasting next month signups",
      "Querying funnel conversions"},
     {"Weekly KPI report", "Churn cohort analysis", "Signup forecast"},
     {"Churn spikes in month two for annual plans. Probably refunds being counted as churn. Verifying.",
      "Signups up 12 percent, but half came from one referral link. Splitting that out.",
      "The funnel drop is at email verification. Checking how long the email takes to arrive."}},
    {"demo-otto", "Otto Support", "Otto", {50, LOOK_ROBOT, 0, 0, 0, 0, ACC_CAP},
     {"Answering a refund request", "Triaging 12 new tickets", "Writing a help center article",
      "Escalating a billing issue"},
     {"Clear ticket backlog", "Refund policy FAQ", "VIP customer follow-up"},
     {"Seven of the twelve tickets are the same export bug. One macro, one bug report, done.",
      "This refund is outside policy by two days. Asking a human before I say yes.",
      "The FAQ answer is correct but long. Cutting it to three sentences and a link."}},
    {"demo-nova", "Nova Writer", "Nova", {340, LOOK_HUMAN, 3, 0, 4, 2, ACC_CAP},
     {"Drafting the launch blog post", "Editing the newsletter", "Writing product release notes",
      "Brainstorming tweet threads"},
     {"Launch announcement", "October newsletter", "Release notes 0.9"},
     {"The headline promises too much. Trying a version that says what it does in six words.",
      "Newsletter is 900 words. Readers stop at 400. Moving the launch news to the top.",
      "Release notes should lead with the fix people asked for most, not the refactor."}},
};
constexpr int N = sizeof(kAgents) / sizeof(kAgents[0]);

const char* const kChat[] = {
    "Pushed the fix, tests are green now.",
    "Can someone review my draft before noon?",
    "Heads up: the API latency spiked for a minute.",
    "Customer says the new dashboard is great!",
    "Found two duplicate invoices, cleaning up.",
    "Deploy finished. Monitoring for 15 minutes.",
    "I need the brand colors for the slide deck.",
    "Weekly numbers are up 12% on signups.",
    "On it. ETA twenty minutes.",
    "Thanks! Closing this one out.",
};
constexpr int NCHAT = sizeof(kChat) / sizeof(kChat[0]);

const char* const kHandoff[] = {
    "can you take it from here?",
    "handing this one to you.",
    "your turn, the draft is ready.",
    "can you double-check the numbers?",
    "ready for your review.",
};
constexpr int NHANDOFF = sizeof(kHandoff) / sizeof(kHandoff[0]);

const char* const kNeeds[] = {
    "Approve the October newsletter send",
    "Approve $240 ad budget for launch week",
    "OK a refund outside policy (2 days late)",
    "Sign off on the v0.9 production deploy",
};
constexpr int NNEEDS = sizeof(kNeeds) / sizeof(kNeeds[0]);

const uint8_t kWorkActs[] = {ACT_TYPING, ACT_WRITING, ACT_REVIEWING, ACT_THINKING, ACT_PRESENTING, ACT_TYPING, ACT_TALKING};
constexpr int NWORK = sizeof(kWorkActs) / sizeof(kWorkActs[0]);

uint32_t s_rng = 0x2545F491u;
uint32_t rnd() {
  s_rng ^= s_rng << 13;
  s_rng ^= s_rng >> 17;
  s_rng ^= s_rng << 5;
  return s_rng;
}
int pick(int n) { return (int)(rnd() % (uint32_t)n); }
int range(int lo, int hi) { return lo + pick(hi - lo); }

uint8_t s_taskIdx[N];
uint8_t s_actIdx[N];
uint8_t s_thoughtIdx[N];
uint32_t s_downUntil[N];
uint32_t s_blockedUntil[N];
uint32_t s_needUntil[N];
uint32_t s_lastTick = 0;
uint32_t s_msgCounter = 0, s_taskCounter = 100, s_eventCounter = 0;
int32_t s_ageAccMs = 0;
uint32_t s_nextHandoff, s_nextDone, s_nextNeeds, s_nextBlocked, s_nextThought, s_nextFlavor, s_nextChat, s_nextDown;
uint8_t s_needsCount = 0;

bool isWorking(const Agent& a) { return a.state == S_WORKING || a.state == S_TYPING; }
bool busy(int i) { return s_downUntil[i] || s_blockedUntil[i] || s_needUntil[i]; }

void setTask(Model& m, int i) {
  Agent& a = m.agents[i];
  strlcpy(a.task, kAgents[i].tasks[s_taskIdx[i] % 3], sizeof(a.task));
  char key[24];
  snprintf(key, sizeof(key), "task-%lu", (unsigned long)++s_taskCounter);
  a.taskHash = fnv1a(key);
  m.s.tasksInProgress++;
}

void setActivity(Model& m, int i) {
  strlcpy(m.agents[i].activity, kAgents[i].activities[s_actIdx[i] % 4], sizeof(m.agents[i].activity));
}

void nextThought(Model& m, int i) {
  model_setThought(m, i, kAgents[i].thoughts[s_thoughtIdx[i]++ % 3], 0);
}

void clearThought(Model& m, int i) {
  Agent& a = m.agents[i];
  if (!a.thought) return;
  Thought& t = m.thoughts[a.thought - 1];
  t.text[0] = 0;
  t.ageSec = 0x7FFFFFFF;  // first to be reused
  a.thought = 0;
}

void setWorking(Model& m, int i, uint8_t act) {
  Agent& a = m.agents[i];
  a.act = act;
  a.state = act == ACT_TALKING ? S_TYPING : S_WORKING;
  if (a.health != H_ATTENTION) a.health = H_HEALTHY;
  a.mood = MOOD_AUTO;
  if (!a.taskHash) setTask(m, i);
  s_actIdx[i]++;
  setActivity(m, i);
}

void setIdle(Model& m, int i) {
  Agent& a = m.agents[i];
  a.act = ACT_IDLE;
  a.state = S_IDLE;
  a.mood = MOOD_AUTO;
  if (a.health != H_ATTENTION) a.health = H_IDLE;
  strlcpy(a.activity, "Taking a short break", sizeof(a.activity));
  clearThought(m, i);
}

void pushMessage(Model& m, int agentIdx, const char* text) {
  if (m.nMsgs >= 8) {
    memmove(&m.msgs[0], &m.msgs[1], sizeof(Message) * (m.nMsgs - 1));
    m.nMsgs--;
  }
  Message& msg = m.msgs[m.nMsgs++];
  memset(&msg, 0, sizeof(msg));
  char key[24];
  snprintf(key, sizeof(key), "msg-%lu", (unsigned long)++s_msgCounter);
  msg.idHash = fnv1a(key);
  if (agentIdx >= 0) {
    msg.agentHash = m.agents[agentIdx].idHash;
    strlcpy(msg.from, m.agents[agentIdx].shortName, sizeof(msg.from));
  } else {
    strlcpy(msg.from, "You", sizeof(msg.from));
  }
  strlcpy(msg.text, text, sizeof(msg.text));
  msg.ageSec = 0;
}

void pushEvent(Model& m, uint8_t type, int a, int b, const char* title) {
  if (m.nEvents >= MAX_EVENTS) m.nEvents = MAX_EVENTS - 1;
  memmove(&m.events[1], &m.events[0], sizeof(Event) * m.nEvents);
  m.nEvents++;
  Event& e = m.events[0];  // newest first, like the server
  memset(&e, 0, sizeof(e));
  char key[24];
  snprintf(key, sizeof(key), "demo-evt-%lu", (unsigned long)++s_eventCounter);
  e.idHash = fnv1a(key);
  e.type = type;
  e.aHash = m.agents[a].idHash;
  e.bHash = b >= 0 ? m.agents[b].idHash : 0;
  strlcpy(e.title, title ? title : "", sizeof(e.title));
}

// A random agent matching the filter, or -1.
template <typename F>
int pickAgent(const Model& m, F ok) {
  int start = pick(N);
  for (int k = 0; k < N; k++) {
    int i = (start + k) % N;
    if (ok(m.agents[i], i)) return i;
  }
  return -1;
}

void handoff(Model& m) {
  int a = pickAgent(m, [](const Agent& g, int i) { return isWorking(g) && !busy(i); });
  if (a < 0) return;
  int b = pickAgent(m, [a](const Agent&, int i) { return i != a && !busy(i); });
  if (b < 0) return;
  char buf[96];
  snprintf(buf, sizeof(buf), "@%s %s", kAgents[b].shortName, kHandoff[pick(NHANDOFF)]);
  pushMessage(m, a, buf);
  pushEvent(m, EV_HANDOFF, a, b, nullptr);
  static const uint8_t kRecv[] = {ACT_REVIEWING, ACT_TYPING, ACT_WRITING};
  setWorking(m, b, kRecv[pick(3)]);
  nextThought(m, b);
}

void taskDone(Model& m) {
  int i = pickAgent(m, [](const Agent& g, int k) { return isWorking(g) && g.taskHash && !busy(k); });
  if (i < 0) return;
  Agent& a = m.agents[i];
  char buf[96];
  snprintf(buf, sizeof(buf), "Done: %s", a.task);
  pushMessage(m, i, buf);
  pushEvent(m, EV_TASK_DONE, i, -1, a.task);
  a.taskHash = 0;
  a.task[0] = 0;
  s_taskIdx[i]++;
  if (m.s.tasksInProgress > 0) m.s.tasksInProgress--;
  setIdle(m, i);
}

void needsYou(Model& m, uint32_t now) {
  if (m.nNeeds >= MAX_NEEDS) return;
  int i = s_needsCount == 0 ? 5 : pickAgent(m, [](const Agent& g, int k) { return isWorking(g) && !busy(k); });
  if (i < 0 || busy(i)) return;
  const char* title = kNeeds[s_needsCount++ % NNEEDS];
  Need& n = m.needs[m.nNeeds++];
  n.agentHash = m.agents[i].idHash;
  strlcpy(n.title, title, sizeof(n.title));
  setWorking(m, i, ACT_WAITING);
  m.agents[i].state = S_WORKING;
  pushEvent(m, EV_NEEDS_YOU, i, -1, title);
  char buf[96];
  snprintf(buf, sizeof(buf), "Need your OK: %s", title);
  pushMessage(m, i, buf);
  m.s.pendingApprovals = m.nNeeds;
  s_needUntil[i] = now + 18000;
}

void answerNeed(Model& m, int i) {
  for (int k = 0; k < m.nNeeds; k++) {
    if (m.needs[k].agentHash != m.agents[i].idHash) continue;
    memmove(&m.needs[k], &m.needs[k + 1], sizeof(Need) * (m.nNeeds - k - 1));
    m.nNeeds--;
    break;
  }
  m.s.pendingApprovals = m.nNeeds;
  pushMessage(m, -1, "Approved. Go ahead.");
  setWorking(m, i, ACT_TYPING);
  m.agents[i].health = H_HEALTHY;
  m.agents[i].unanswered = 0;
}

void blocked(Model& m, uint32_t now) {
  int i = pickAgent(m, [](const Agent& g, int k) { return isWorking(g) && g.taskHash && !busy(k); });
  if (i < 0) return;
  Agent& a = m.agents[i];
  a.act = ACT_BLOCKED;
  a.mood = MOOD_WORRIED;
  a.health = H_ATTENTION;
  pushEvent(m, EV_BLOCKED, i, -1, a.task);
  model_setThought(m, i, "Blocked: no access to the analytics database. Asked ops, waiting on a grant.", 0);
  pushMessage(m, i, "Blocked: missing access to the analytics DB.");
  s_blockedUntil[i] = now + 10000;
}

void flavor(Model& m) {
  int i = pickAgent(m, [](const Agent&, int k) { return !busy(k); });
  if (i < 0) return;
  Agent& a = m.agents[i];
  if (!isWorking(a)) {
    setWorking(m, i, kWorkActs[pick(NWORK)]);
    if (a.act != ACT_TALKING) nextThought(m, i);
  } else if (pick(100) < 18) {
    setIdle(m, i);
  } else {
    uint8_t act = kWorkActs[pick(NWORK)];
    if (act == a.act) act = kWorkActs[(pick(NWORK) + 1) % NWORK];
    setWorking(m, i, act);
    if (act == ACT_TALKING) pushMessage(m, i, kChat[pick(NCHAT)]);
  }
}

}  // namespace

void demo_init(Model& m) {
  memset(&m, 0, sizeof(m));
  m.demo = true;
  m.version = 2;
  strlcpy(m.company, "Demo Empire", sizeof(m.company));
  m.nAgents = N;
  static const uint8_t initAct[N] = {ACT_TYPING, ACT_REVIEWING, ACT_IDLE, ACT_PRESENTING, ACT_OFFLINE, ACT_TALKING, ACT_WRITING};
  uint32_t now = millis();
  memset(s_downUntil, 0, sizeof(s_downUntil));
  memset(s_blockedUntil, 0, sizeof(s_blockedUntil));
  memset(s_needUntil, 0, sizeof(s_needUntil));
  s_needsCount = 0;
  for (int i = 0; i < N; i++) {
    Agent& a = m.agents[i];
    a.idHash = fnv1a(kAgents[i].id);
    strlcpy(a.name, kAgents[i].name, sizeof(a.name));
    strlcpy(a.shortName, kAgents[i].shortName, sizeof(a.shortName));
    a.look = kAgents[i].look;
    a.hue = a.look.hue;
    a.lastSeenSec = 3 + pick(20);
    s_taskIdx[i] = (uint8_t)pick(3);
    s_actIdx[i] = (uint8_t)pick(4);
    s_thoughtIdx[i] = (uint8_t)pick(3);
    setActivity(m, i);
    if (initAct[i] == ACT_IDLE) {
      setIdle(m, i);
    } else if (initAct[i] != ACT_OFFLINE) {
      setWorking(m, i, initAct[i]);
      if (initAct[i] != ACT_TALKING) nextThought(m, i);
    }
  }
  // One agent needs attention, one is down, so every visual shows up right away.
  m.agents[5].health = H_ATTENTION;
  m.agents[5].unanswered = 2;
  m.agents[4].state = S_OFFLINE;
  m.agents[4].health = H_DOWN;
  m.agents[4].act = ACT_OFFLINE;
  m.agents[4].lastSeenSec = 340;
  s_downUntil[4] = now + 25000;
  m.s.tasksOverdue = 0;
  {
    // A private chat with the first agent, newest first.
    static const struct {
      bool me;
      int32_t age;
      const char* text;
    } kDm[] = {
        {false, 240, "Draft is in your inbox. Two charts still need numbers from finance."},
        {true, 420, "Can you send me the Q3 draft before lunch?"},
    };
    Agent& a = m.agents[0];
    a.dmStart = m.nDm;
    for (const auto& d : kDm) {
      DmMsg& g = m.dm[m.nDm++];
      g.me = d.me;
      g.ageSec = d.age;
      strlcpy(g.text, d.text, sizeof(g.text));
      a.dmCount++;
    }
    a.dmNewestSec = kDm[0].age;
  }
  pushMessage(m, 0, "Morning team. Q3 report draft is underway.");
  pushMessage(m, 1, "Billing webhook refactor is 80% done.");
  pushMessage(m, 6, "Launch post outline is ready for review.");
  for (int i = 0; i < m.nMsgs; i++) m.msgs[i].ageSec = (m.nMsgs - i) * 45;
  model_recount(m);
  s_nextHandoff = now + 3000;
  s_nextDone = now + 7000;
  s_nextNeeds = now + 12000;
  s_nextBlocked = now + 22000;
  s_nextThought = now + 5000;
  s_nextFlavor = now + 4000;
  s_nextChat = now + 9000;
  s_nextDown = now + 60000;
  s_lastTick = now;
}

static inline bool due(uint32_t now, uint32_t t) { return (int32_t)(now - t) >= 0; }

bool demo_tick(Model& m, uint32_t now) {
  // Age timestamps.
  uint32_t dt = now - s_lastTick;
  s_lastTick = now;
  s_ageAccMs += dt;
  bool changed = false;
  while (s_ageAccMs >= 1000) {
    s_ageAccMs -= 1000;
    changed = true;
    for (int i = 0; i < m.nMsgs; i++) m.msgs[i].ageSec++;
    for (int i = 0; i < m.nThoughts; i++)
      if (m.thoughts[i].ageSec < 0x7FFFFFFF) m.thoughts[i].ageSec++;
    for (int i = 0; i < m.nEvents; i++) m.events[i].ageSec++;
    while (m.nEvents && m.events[m.nEvents - 1].ageSec > 600) m.nEvents--;
    for (int i = 0; i < m.nAgents; i++) {
      Agent& a = m.agents[i];
      if (isWorking(a)) a.lastSeenSec = pick(4);
      else a.lastSeenSec++;
    }
  }

  for (int i = 0; i < N; i++) {
    // Recover downed agents.
    if (s_downUntil[i] && due(now, s_downUntil[i])) {
      s_downUntil[i] = 0;
      m.agents[i].health = H_IDLE;
      m.agents[i].lastSeenSec = 0;
      setIdle(m, i);
      pushMessage(m, i, "I'm back online. Catching up now.");
      changed = true;
    }
    if (s_blockedUntil[i] && due(now, s_blockedUntil[i])) {
      s_blockedUntil[i] = 0;
      m.agents[i].health = H_HEALTHY;
      setWorking(m, i, ACT_TYPING);
      model_setThought(m, i, "Access granted. Re-running the query from where it stopped.", 0);
      pushMessage(m, i, "Unblocked, thanks ops!");
      changed = true;
    }
    if (s_needUntil[i] && due(now, s_needUntil[i])) {
      s_needUntil[i] = 0;
      answerNeed(m, i);
      changed = true;
    }
  }

  if (due(now, s_nextHandoff)) {
    s_nextHandoff = now + range(7000, 9500);
    handoff(m);
    changed = true;
  }
  if (due(now, s_nextDone)) {
    s_nextDone = now + range(14000, 16500);
    taskDone(m);
    changed = true;
  }
  if (due(now, s_nextNeeds)) {
    s_nextNeeds = now + range(42000, 50000);
    needsYou(m, now);
    changed = true;
  }
  if (due(now, s_nextBlocked)) {
    s_nextBlocked = now + range(30000, 36000);
    blocked(m, now);
    changed = true;
  }
  if (due(now, s_nextThought)) {
    s_nextThought = now + range(4500, 7000);
    int i = pickAgent(m, [](const Agent& g, int k) {
      return isWorking(g) && !busy(k) && g.act != ACT_TALKING && g.act != ACT_WAITING;
    });
    if (i >= 0) nextThought(m, i);
    changed = true;
  }
  if (due(now, s_nextFlavor)) {
    s_nextFlavor = now + range(3500, 6000);
    flavor(m);
    changed = true;
  }
  if (due(now, s_nextChat)) {
    s_nextChat = now + range(6000, 10000);
    int i = pickAgent(m, [](const Agent&, int k) { return !s_downUntil[k]; });
    if (i >= 0) pushMessage(m, i, kChat[pick(NCHAT)]);
    changed = true;
  }
  if (due(now, s_nextDown)) {
    s_nextDown = now + range(60000, 80000);
    int i = pickAgent(m, [](const Agent& g, int k) { return !isWorking(g) && !busy(k); });
    if (i >= 0) {
      Agent& a = m.agents[i];
      a.state = S_OFFLINE;
      a.health = H_DOWN;
      a.act = ACT_OFFLINE;
      clearThought(m, i);
      s_downUntil[i] = now + range(15000, 25000);
    }
    changed = true;
  }
  if (changed) model_recount(m);
  return changed;
}
