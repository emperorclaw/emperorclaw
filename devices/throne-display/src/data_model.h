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
// Feed v2. Thoughts (raw reasoning snippets, <=140 chars) are the biggest new field, so
// only the MAX_THOUGHTS freshest are kept in a shared pool instead of one per agent.
constexpr int MAX_THOUGHTS = 6;
constexpr int THOUGHT_TEXT = 141;
constexpr int MAX_EVENTS = 10;
constexpr int MAX_NEEDS = 3;
constexpr int TITLE_TEXT = 57;

enum Health : uint8_t { H_HEALTHY = 0, H_ATTENTION, H_DOWN, H_IDLE };
enum AgentState : uint8_t { S_TYPING = 0, S_WORKING, S_IDLE, S_OFFLINE };

// What the character acts out (feed v2 `act`). ACT_AUTO = not sent (v1 server):
// the UI derives one from `state`.
enum Act : uint8_t {
  ACT_AUTO = 0,
  ACT_TYPING,
  ACT_WRITING,
  ACT_REVIEWING,
  ACT_PRESENTING,
  ACT_TALKING,
  ACT_THINKING,
  ACT_WAITING,
  ACT_BLOCKED,
  ACT_CELEBRATE,
  ACT_COFFEE,
  ACT_NAP,
  ACT_STRETCH,
  ACT_OFFLINE,
  ACT_IDLE,
};

// Facial expression (feed v2 `mood`). MOOD_AUTO = derived from the act.
enum Mood : uint8_t { MOOD_AUTO = 0, MOOD_NEUTRAL, MOOD_HAPPY, MOOD_FOCUSED, MOOD_WORRIED, MOOD_SLEEPY, MOOD_SCANNING };

enum EventType : uint8_t { EV_NONE = 0, EV_HANDOFF, EV_TASK_DONE, EV_NEEDS_YOU, EV_BLOCKED };

enum LookKind : uint8_t { LOOK_NONE = 0, LOOK_ROBOT, LOOK_HUMAN };
enum Accessory : uint8_t { ACC_NONE = 0, ACC_GLASSES, ACC_HEADSET, ACC_CAP, ACC_BOW };

// Compact character spec (feed v2 `look`, same model as the web's src/lib/character).
// kind == LOOK_NONE means "not sent": the UI derives one from the id hash.
struct Look {
  uint16_t hue;
  uint8_t kind;
  uint8_t variant;    // 0..3
  uint8_t skin;       // 0..5 (SKIN_TONES)
  uint8_t hairColor;  // 0..7 (HAIR_COLORS)
  uint8_t hairStyle;  // 0..5
  uint8_t acc;        // Accessory
};

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
  Look look;
  uint8_t act;      // Act
  uint8_t mood;     // Mood
  uint8_t thought;  // 1-based slot in Model::thoughts, 0 = none
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

// Latest reasoning snippet of one agent (feed v2 `thought` / `thoughtAgeSec`).
struct Thought {
  uint32_t agentHash;
  int32_t ageSec;
  char text[THOUGHT_TEXT];
};

// One moment from feed v2 `events[]`. The id hash de-duplicates playback.
struct Event {
  uint32_t idHash;
  uint32_t aHash;  // actor
  uint32_t bHash;  // handoff recipient, 0 otherwise
  int32_t ageSec;
  uint8_t type;    // EventType
  char title[TITLE_TEXT];
};

// A pending approval / request addressed to humans (feed v2 `needs[]`).
struct Need {
  uint32_t agentHash;
  char title[TITLE_TEXT];
};

struct Summary {
  int16_t agents, healthy, attention, down, idle, working;
  int16_t pendingApprovals, tasksInProgress, tasksOverdue;
};

struct Model {
  uint32_t seq;         // bumped on every publish
  uint32_t receivedMs;  // millis() when the snapshot was produced (for relative times)
  bool demo;
  uint8_t version;  // feed `v` (1 = no v2 fields)
  uint8_t nAgents;
  uint8_t nMsgs;  // ordered oldest -> newest
  uint8_t nDm;
  uint8_t nThoughts;
  uint8_t nEvents;  // newest first
  uint8_t nNeeds;
  char company[32];
  Summary s;
  Agent agents[MAX_AGENTS];
  Message msgs[MAX_MESSAGES];
  DmMsg dm[MAX_DM];  // grouped per agent (see Agent::dmStart / dmCount)
  Thought thoughts[MAX_THOUGHTS];
  Event events[MAX_EVENTS];
  Need needs[MAX_NEEDS];
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
// Store a thought for agent idx in the shared pool: reuses the agent's slot, else a
// free one, else evicts the stalest. Returns false when every slot is fresher.
bool model_setThought(Model& m, int idx, const char* text, int32_t ageSec);
// The agent's thought text, or nullptr.
const Thought* model_thought(const Model& m, const Agent& a);
