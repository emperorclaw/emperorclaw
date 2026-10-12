// Moments: short scripted scenes triggered by feed v2 `events[]` (handoff paper planes,
// task-done confetti + crown flash, needs-you knocks on the glass, blocked alerts),
// the needs-you card, and typewriter thought bubbles.
//
// Events are de-duplicated by id (a ring of recently seen id hashes) so each plays
// once. On the first snapshot after boot (or a demo / live switch) only events younger
// than 60 s play, so a restart does not replay the last ten minutes.
#pragma once
#include <Arduino.h>

#include "data_model.h"

struct Moment {
  uint8_t type;  // EventType
  uint32_t aHash, bHash;
  uint32_t start, dur;
  uint32_t serial;  // increments for every moment started
  char title[TITLE_TEXT];
};

void moments_sync(bool firstSync);  // after app.model was replaced
void moments_update();              // once per frame (called by app_update)
// World space (inside the throne room, before a Director zoom): paper planes, glass ripples.
void moments_drawWorld();
// The Throne Room's own rotating thought bubble.
void moments_drawThroneBubble();
// Screen space: toasts for the moment playing now.
void moments_drawOverlay();
// Screen space: the needs-you card, when open (any mode).
void moments_drawNeedsCard();
// Screen offset while an agent knocks on the glass.
int moments_nudgeX();
// Newest moment still playing, or nullptr.
const Moment* moments_current();
// Crown flash intensity 0..1024 after a task_done.
int moments_crownFlash();
// True while the Emperor knocks on the glass (a need without a requesting agent);
// *hit is set on the frames where the knock lands.
bool moments_emperorKnock(bool* hit);
// Tap in the throne room / Director. Opens (or closes) the needs card when the tap
// hits the outer ring, a waiting agent, or anywhere when `anywhere`. True if consumed.
bool moments_tap(int x, int y, bool anywhere);
bool moments_cardOpen();

// Thought bubble: pops up, types the text out, holds, then shrinks away.
struct Bubble {
  bool on;
  uint8_t n, nLines;
  int16_t w;  // widest wrapped line, px
  uint32_t agentHash, textHash, start;
  uint16_t st[8];
  uint8_t ln[8];
  char text[THOUGHT_TEXT];
};
void bubble_start(Bubble& b, uint32_t agentHash, const char* text);
uint32_t bubble_duration(const Bubble& b);
// Draws above (or below) the agent whose head is at (ax, headY) and feet at footY,
// in screen coordinates. Returns false once the bubble has finished.
bool bubble_draw(Bubble& b, int ax, int headY, int footY);
