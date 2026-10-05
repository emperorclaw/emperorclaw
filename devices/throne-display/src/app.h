// UI-side state shared by all modes: the render copy of the model, per-agent
// animation state (kept stable across updates by matching agent id hashes), and
// mode / navigation state.
#pragma once
#include <Arduino.h>

#include "data_model.h"
#include "sprites.h"

enum Mode : uint8_t { MODE_THRONE = 0, MODE_FOCUS, MODE_PULSE, MODE_FEED, MODE_COUNT };

struct AgentAnim {
  uint32_t idHash;
  int32_t x, y;    // Q8 current position (throne room)
  int32_t tx, ty;  // Q8 wander target
  int16_t deskX, deskY;
  uint32_t stateSince;
  uint32_t nextWander;
  uint32_t lastTaskHash;
  uint8_t lastState, lastHealth;
  bool walking;
  bool faceLeft;
  uint8_t ramp;
  CharSprite spr;
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
// Per-frame simulation for the throne room (wandering, particles).
void app_update();

uint8_t healthRamp(uint8_t health);
uint8_t stateRamp(uint8_t state);
const char* stateLabel(uint8_t state);
const char* healthLabel(uint8_t health);
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

// Modes
void throne_draw();
bool throne_tap(int x, int y);  // returns true if an agent was tapped (switches to focus)
void focus_draw();
void focus_step(int dir);
void focus_openChat(bool open);
void focus_scrollChat(int dir);  // +1 = older, -1 = newer
void pulse_draw();
bool pulse_tap(int x, int y);
void feed_draw();
