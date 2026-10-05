#include "demo_data.h"

namespace {

struct DemoAgent {
  const char* id;
  const char* name;
  const char* shortName;
  uint16_t hue;
  const char* activities[4];
  const char* tasks[3];
};

const DemoAgent kAgents[] = {
    {"demo-ada", "Ada Researcher", "Ada", 212,
     {"Reading the Q3 market report", "Comparing three competitor pricing pages", "Summarizing customer interviews",
      "Collecting sources on AI regulation"},
     {"Draft Q3 summary", "Competitor pricing scan", "Interview synthesis"}},
    {"demo-max", "Max Builder", "Max", 28,
     {"Refactoring the billing webhook", "Running the integration test suite", "Fixing a flaky login test",
      "Reviewing pull request 482"},
     {"Ship invoice export", "Fix flaky auth test", "Upgrade database driver"}},
    {"demo-luna", "Luna Designer", "Luna", 300,
     {"Sketching the onboarding flow", "Polishing icon set for dark mode", "Exporting hero images",
      "Tuning the brand color tokens"},
     {"Onboarding redesign", "Dark mode icons", "Landing hero art"}},
    {"demo-rex", "Rex Ops", "Rex", 140,
     {"Rotating TLS certificates", "Watching the deploy pipeline", "Tuning database backups",
      "Checking error budgets"},
     {"Nightly backup audit", "Deploy v0.9 to prod", "Alert noise cleanup"}},
    {"demo-iris", "Iris Analyst", "Iris", 180,
     {"Building the weekly KPI dashboard", "Cleaning churn data", "Forecasting next month signups",
      "Querying funnel conversions"},
     {"Weekly KPI report", "Churn cohort analysis", "Signup forecast"}},
    {"demo-otto", "Otto Support", "Otto", 50,
     {"Answering a refund request", "Triaging 12 new tickets", "Writing a help center article",
      "Escalating a billing issue"},
     {"Clear ticket backlog", "Refund policy FAQ", "VIP customer follow-up"}},
    {"demo-nova", "Nova Writer", "Nova", 340,
     {"Drafting the launch blog post", "Editing the newsletter", "Writing product release notes",
      "Brainstorming tweet threads"},
     {"Launch announcement", "October newsletter", "Release notes 0.9"}},
};
constexpr int N = sizeof(kAgents) / sizeof(kAgents[0]);

const char* const kChat[] = {
    "Pushed the fix, tests are green now.",
    "Can someone review my draft before noon?",
    "Heads up: the API latency spiked for a minute.",
    "Customer says the new dashboard is great!",
    "Waiting on approval to send the newsletter.",
    "Found two duplicate invoices, cleaning up.",
    "Deploy finished. Monitoring for 15 minutes.",
    "I need the brand colors for the slide deck.",
    "Weekly numbers are up 12% on signups.",
    "Blocked: missing access to the analytics DB.",
    "On it. ETA twenty minutes.",
    "Thanks! Closing this one out.",
};
constexpr int NCHAT = sizeof(kChat) / sizeof(kChat[0]);

uint32_t s_rng = 0x2545F491u;
uint32_t rnd() {
  s_rng ^= s_rng << 13;
  s_rng ^= s_rng >> 17;
  s_rng ^= s_rng << 5;
  return s_rng;
}
int pick(int n) { return (int)(rnd() % (uint32_t)n); }

uint8_t s_taskIdx[N];
uint8_t s_actIdx[N];
uint32_t s_downUntil[N];
uint32_t s_nextEvent = 0;
uint32_t s_lastTick = 0;
uint32_t s_msgCounter = 0;
uint32_t s_taskCounter = 100;
int32_t s_ageAccMs = 0;

void setTask(Model& m, int i) {
  Agent& a = m.agents[i];
  const char* t = kAgents[i].tasks[s_taskIdx[i] % 3];
  strlcpy(a.task, t, sizeof(a.task));
  char key[24];
  snprintf(key, sizeof(key), "task-%lu", (unsigned long)++s_taskCounter);
  a.taskHash = fnv1a(key);
}

void setActivity(Model& m, int i) {
  strlcpy(m.agents[i].activity, kAgents[i].activities[s_actIdx[i] % 4], sizeof(m.agents[i].activity));
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

}  // namespace

void demo_init(Model& m) {
  memset(&m, 0, sizeof(m));
  m.demo = true;
  strlcpy(m.company, "Demo Empire", sizeof(m.company));
  m.nAgents = N;
  static const uint8_t initState[N] = {S_WORKING, S_TYPING, S_IDLE, S_WORKING, S_IDLE, S_TYPING, S_WORKING};
  for (int i = 0; i < N; i++) {
    Agent& a = m.agents[i];
    a.idHash = fnv1a(kAgents[i].id);
    strlcpy(a.name, kAgents[i].name, sizeof(a.name));
    strlcpy(a.shortName, kAgents[i].shortName, sizeof(a.shortName));
    a.hue = kAgents[i].hue;
    a.state = initState[i];
    a.health = a.state == S_IDLE ? H_IDLE : H_HEALTHY;
    a.lastSeenSec = 3 + pick(20);
    s_taskIdx[i] = (uint8_t)pick(3);
    s_actIdx[i] = (uint8_t)pick(4);
    setActivity(m, i);
    if (a.state != S_IDLE) setTask(m, i);
  }
  // One agent needs attention, one is down, so every visual shows up right away.
  m.agents[5].health = H_ATTENTION;
  m.agents[5].unanswered = 2;
  m.agents[4].state = S_OFFLINE;
  m.agents[4].health = H_DOWN;
  m.agents[4].lastSeenSec = 340;
  s_downUntil[4] = millis() + 25000;
  m.s.pendingApprovals = 1;
  m.s.tasksInProgress = 5;
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
  s_nextEvent = millis() + 2500;
  s_lastTick = millis();
}

bool demo_tick(Model& m, uint32_t now) {
  // Age timestamps.
  uint32_t dt = now - s_lastTick;
  s_lastTick = now;
  s_ageAccMs += dt;
  bool changed = false;
  while (s_ageAccMs >= 1000) {
    s_ageAccMs -= 1000;
    for (int i = 0; i < m.nMsgs; i++) m.msgs[i].ageSec++;
    for (int i = 0; i < m.nAgents; i++) {
      Agent& a = m.agents[i];
      if (a.state == S_WORKING || a.state == S_TYPING) a.lastSeenSec = pick(4);
      else a.lastSeenSec++;
    }
  }

  // Recover downed agents.
  for (int i = 0; i < N; i++) {
    if (s_downUntil[i] && (int32_t)(now - s_downUntil[i]) >= 0) {
      s_downUntil[i] = 0;
      m.agents[i].state = S_IDLE;
      m.agents[i].health = H_IDLE;
      m.agents[i].lastSeenSec = 0;
      pushMessage(m, i, "I'm back online. Catching up now.");
      changed = true;
    }
  }

  if ((int32_t)(now - s_nextEvent) < 0) {
    if (changed) model_recount(m);
    return changed;
  }
  s_nextEvent = now + 1800 + pick(2200);

  int i = pick(N);
  Agent& a = m.agents[i];
  if (s_downUntil[i]) return changed;  // ghosts stay ghosts until recovery
  int roll = pick(100);
  if (roll < 32) {
    // State change
    static const uint8_t states[] = {S_WORKING, S_TYPING, S_IDLE, S_WORKING};
    uint8_t ns = states[pick(4)];
    if (ns == a.state) ns = a.state == S_IDLE ? S_WORKING : S_IDLE;
    a.state = ns;
    if (a.health != H_ATTENTION) a.health = ns == S_IDLE ? H_IDLE : H_HEALTHY;
    s_actIdx[i]++;
    setActivity(m, i);
    if (ns != S_IDLE && !a.taskHash) {
      setTask(m, i);
      m.s.tasksInProgress++;
    }
  } else if (roll < 50) {
    // Task completed: task disappears (confetti) and the agent posts about it.
    if (a.taskHash) {
      char buf[96];
      snprintf(buf, sizeof(buf), "Done: %s", a.task);
      pushMessage(m, i, buf);
      a.taskHash = 0;
      a.task[0] = 0;
      s_taskIdx[i]++;
      if (m.s.tasksInProgress > 0) m.s.tasksInProgress--;
      a.state = S_IDLE;
      if (a.health != H_ATTENTION) a.health = H_IDLE;
      strlcpy(a.activity, "Taking a short break", sizeof(a.activity));
    } else {
      setTask(m, i);
      a.state = S_WORKING;
      if (a.health != H_ATTENTION) a.health = H_HEALTHY;
      s_actIdx[i]++;
      setActivity(m, i);
      m.s.tasksInProgress++;
    }
  } else if (roll < 74) {
    pushMessage(m, i, kChat[pick(NCHAT)]);
    a.state = S_TYPING;
    if (a.health == H_IDLE) a.health = H_HEALTHY;
  } else if (roll < 86) {
    if (a.health == H_ATTENTION) {
      a.health = a.state == S_IDLE ? H_IDLE : H_HEALTHY;
      a.unanswered = 0;
      pushMessage(m, -1, "Answered. Go ahead.");
    } else {
      a.health = H_ATTENTION;
      a.unanswered = 1 + pick(3);
      pushMessage(m, i, "Question: should I wait for approval?");
    }
  } else if (roll < 91) {
    a.state = S_OFFLINE;
    a.health = H_DOWN;
    s_downUntil[i] = now + 15000 + pick(15000);
  } else {
    m.s.pendingApprovals = (int16_t)pick(3);
    m.s.tasksOverdue = (int16_t)(pick(4) == 0 ? 1 : 0);
  }
  model_recount(m);
  return true;
}
