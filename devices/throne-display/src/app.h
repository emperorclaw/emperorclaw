// UI-side state shared by all modes: the render copy of the model, per-agent
// animation state (kept stable across updates by matching agent id hashes), and
// mode / navigation state.
#pragma once
#include <Arduino.h>

#include "character.h"
#include "data_model.h"

// Director is last so the serial `mode <n>` numbers of the v1 modes stay the same;
// one swipe right from the Throne Room (the default) reaches it.
enum Mode : uint8_t { MODE_THRONE = 0, MODE_FOCUS, MODE_PULSE, MODE_FEED, MODE_DIRECTOR, MODE_COUNT };

// Camera-safe preference (NVS "throne-ui"/"camsafe"). AUTO (never toggled) = on in
// Director only; after a double-tap it is explicitly on or off in every mode.
enum CamSafe : uint8_t { CAMSAFE_OFF = 0, CAMSAFE_ON = 1, CAMSAFE_AUTO = 255 };

struct AgentAnim {
  uint32_t idHash;
  int32_t x, y;    // Q8 feet position (throne room)
  int32_t tx, ty;  // Q8 wander target
  int16_t deskX, deskY;
  uint32_t stateSince;
  uint32_t nextWander;
  uint32_t lastTaskHash;
  uint8_t lastState, lastHealth;
  bool walking;
  bool faceLeft;
  bool seated;    // arrived at the desk (legs hidden behind it)
  bool atGlass;   // arrived at the front glass (drawn one scale larger)
  uint8_t ramp;
  Look look;      // resolved: feed `look` or derived from the id hash
  uint8_t act;    // resolved Act for this frame (feed act + moments + idle routines)
  uint8_t mood;   // resolved Mood for this frame
  uint32_t actSince;
  uint32_t glassSince;
  // Moment timers (millis deadlines, 0 = off).
  uint32_t celebrateUntil, receiveUntil, knockUntil, blockedUntil, throwUntil;
  uint32_t shownThought;  // hash of the last thought shown in a bubble
};

struct App {
  Model model;
  uint32_t modelSeq;
  bool hasModel;
  AgentAnim anim[MAX_AGENTS];
  uint8_t mode;
  uint8_t focus;
  uint32_t now;
  uint32_t dt;
  uint32_t lastDataChangeMs;
  uint8_t charScale;  // character scale in the throne room (2, or 1 when crowded)
  uint8_t camSafePref;
  uint32_t camSafeToastMs;
  uint32_t camSafeHintMs;  // "hold to turn off" hint after a double-tap while on
  // focus paging animation
  uint32_t focusChangeMs;
  int8_t focusDir;
  // feed slide-in animation
  uint32_t feedNewestHash;
  uint32_t feedSlideStart;
  // focus: private chat view for the focused agent
  bool chatOpen;
  uint8_t chatScroll;  // newest messages hidden below the view (scrolled up)
  uint32_t chatOpenMs;
};

extern App app;

// Call after app.model has been replaced with a new snapshot.
void app_syncAnim(bool firstSync);
// Per-frame simulation for the throne room (acting, walking, particles).
void app_update();

uint8_t healthRamp(uint8_t health);
uint8_t stateRamp(uint8_t state);
const char* stateLabel(uint8_t state);
const char* healthLabel(uint8_t health);
// Present-tense verb for an act ("typing", "on a coffee break").
const char* actVerb(uint8_t act);
// "12s ago", "5m ago", "2h ago", "3d ago"
void fmtAgo(char* out, size_t cap, int32_t sec);
// Seconds elapsed since the model snapshot was received.
int32_t app_snapshotAgeSec();
int app_agentByHash(uint32_t idHash);
// True while the agent's newest private message is younger than DM_RECENT_SEC
// (aged locally since the last 200, like every other clock on the screen).
bool app_hasRecentDm(const Agent& a);
// Small envelope badge for "new private message", centered at (x, y).
void drawDmBadge(int x, int y);
// Small padlock icon, centered at (x, y).
void drawLock(int x, int y, uint8_t color);

// Camera-safe: scramble text and hide names in the current mode.
void app_loadPrefs();
bool app_camSafe();
void app_toggleCamSafe();
// Sets camera-safe explicitly (saved, applies in every mode from then on).
void app_setCamSafe(bool on);
// Display name for an agent: its name / short name, or initials ("A.R.") when camera-safe.
void app_label(const Agent& a, char* out, size_t cap, bool shortName);
// Initials of any name ("Ada Researcher" -> "A.R.").
void app_initials(const char* name, char* out, size_t cap);
// Pose for an agent's resolved act / mood at its current spot.
Pose app_pose(int i);
// True on the frames where a knocking agent's fist hits the glass.
bool app_knockHit(int i);

// Modes
void throne_draw(bool director);
bool throne_tap(int x, int y);  // returns true if an agent was tapped (switches to focus)
int throne_hit(int x, int y);   // agent index under (x, y), -1 if none
// One agent at (x, footY) with its pose, props and overhead marks (shared by Focus).
void actor_draw(int i, int x, int footY, int scale, bool seated);
// Where agent i stands in the throne room (world coordinates) and its draw scale.
void actor_anchor(int i, int& x, int& footY, int& scale);
void focus_draw();
void focus_step(int dir);
void focus_openChat(bool open);
void focus_scrollChat(int dir);  // +1 = older, -1 = newer
void pulse_draw();
bool pulse_tap(int x, int y);
void feed_draw();
void director_enter();
void director_draw();
