// Fixed-size snapshot of the company state shown on the display.
// The network/demo producer fills a private Model, then publishes it into a
// mutex-guarded shared copy. The render loop copies the shared snapshot into
// its own Model when the sequence number changes, so drawing never blocks on I/O
// and never touches heap-allocated strings.
#pragma once
#include <Arduino.h>

constexpr int MAX_AGENTS = 24;
constexpr int MAX_MESSAGES = 12;
// Private chats (`dm`): at most 4 per agent and 40 in total (the server's caps),
// stored in one shared pool so 24 agents do not each reserve 4 slots.
constexpr int MAX_DM_PER_AGENT = 4;
constexpr int MAX_DM = 40;
constexpr int DM_TEXT = 104;
// An agent shows a "new private message" badge while its newest dm is younger than this.
constexpr int32_t DM_RECENT_SEC = 600;

enum Health : uint8_t { H_HEALTHY = 0, H_ATTENTION, H_DOWN, H_IDLE };
enum AgentState : uint8_t { S_TYPING = 0, S_WORKING, S_IDLE, S_OFFLINE };

struct Agent {
  uint32_t idHash;    // FNV-1a of the agent id (seed for its pixel-art character)
  uint32_t taskHash;  // FNV-1a of the current task id, 0 = no task
  int32_t lastSeenSec;  // -1 = unknown
  uint16_t hue;
  uint16_t unanswered;
  uint8_t health;
  uint8_t state;
  uint8_t dmStart;      // index of the agent's newest message in Model::dm
  uint8_t dmCount;      // 0..MAX_DM_PER_AGENT, newest first
  int32_t dmNewestSec;  // age of the newest dm at receive time, -1 = none
  char name[28];
  char shortName[12];
  char activity[88];
  char task[56];
};

struct Message {
  uint32_t idHash;
  uint32_t agentHash;  // 0 = not an agent (human / system)
  int32_t ageSec;
  char from[16];
  char text[120];
};

// One message of the token creator's private chat with an agent.
struct DmMsg {
  int32_t ageSec;
  bool me;  // written by the token's creator (right-aligned); otherwise the agent's reply
  char text[DM_TEXT];
};

struct Summary {
  int16_t agents, healthy, attention, down, idle, working;
  int16_t pendingApprovals, tasksInProgress, tasksOverdue;
};

struct Model {
  uint32_t seq;         // bumped on every publish
  uint32_t receivedMs;  // millis() when the snapshot was produced (for relative times)
  bool demo;
  uint8_t nAgents;
  uint8_t nMsgs;  // ordered oldest -> newest
  uint8_t nDm;
  char company[32];
  Summary s;
  Agent agents[MAX_AGENTS];
  Message msgs[MAX_MESSAGES];
  DmMsg dm[MAX_DM];  // grouped per agent (see Agent::dmStart / dmCount)
};

enum NetStatus : uint8_t { NET_DEMO = 0, NET_WIFI, NET_CONNECTING, NET_OK, NET_ERROR, NET_PORTAL };

struct NetInfo {
  volatile uint8_t status;
  volatile bool fetching;
  volatile int16_t lastHttp;
  volatile uint32_t lastOkMs;
  volatile uint32_t okCount;
  volatile uint32_t errCount;
};

extern NetInfo g_net;

void model_init();
// Producer side: copy m into the shared slot (sets seq / receivedMs).
void model_publish(Model& m);
// Consumer side: copies the shared snapshot into dst if it is newer than lastSeq.
bool model_take(Model& dst, uint32_t& lastSeq);

uint32_t fnv1a(const char* s);
// Copy UTF-8 text into a fixed buffer as printable ASCII (fonts are ASCII only).
// Accented Latin letters fold to their base letter, so "Katarina" keeps its i.
void asciiCopy(char* dst, size_t cap, const char* src);
// Recompute summary counters from the agent list (used by demo mode).
void model_recount(Model& m);
