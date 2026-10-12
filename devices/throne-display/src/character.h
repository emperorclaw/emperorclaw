// Pixel-art characters that mirror the web character model (src/lib/character):
// robot or human, 4 variants, 6 skin tones, 8 hair colors x 6 styles, an accessory
// (glasses, headset, cap, bow) and 6 expressions. Drawn procedurally every frame on a
// 16x20 logical grid (no per-agent bitmaps in RAM), scaled 1..4x, with a 1-pixel
// outline at any scale. Poses (arms / legs) carry the acting; props are drawn by the
// caller around the hand / head anchors.
#pragma once
#include <Arduino.h>

#include "data_model.h"

constexpr int CHAR_W = 16, CHAR_H = 20;

enum Arms : uint8_t {
  ARMS_DOWN = 0,
  ARMS_TYPE,   // forearms forward, hands alternate (frame)
  ARMS_UP,     // both up (celebrate, stretch)
  ARMS_POINT,  // right arm straight out (presenting)
  ARMS_HOLD,   // right hand raised in front of the chest (mug, magnifier, pen)
  ARMS_KNOCK,  // right fist raised, moves with the frame (knocking on the glass)
  ARMS_THROW,  // right arm high (throwing a paper plane)
};

enum Legs : uint8_t { LEGS_STAND = 0, LEGS_WALK, LEGS_SEATED };

struct Pose {
  uint8_t expr;   // Mood (MOOD_NEUTRAL..MOOD_SCANNING; MOOD_AUTO draws neutral)
  uint8_t arms;   // Arms
  uint8_t legs;   // Legs
  uint8_t frame;  // animation frame 0..3
  bool flip;      // mirrored (facing left)
  bool ghost;     // grey, dithered (down / offline)
};

// Builds the palette lookups for skin and hair colors. Call after pal::build().
void char_init();
// Deterministic look from the agent id hash, mirroring deriveAppearance() in
// src/lib/character/model.ts (used when the server sends no `look`).
void char_derive(uint32_t idHash, uint16_t hue, Look& out);
// Draws with the feet at (cx, footY). seed staggers blinking between characters.
void char_draw(const Look& L, const Pose& p, int cx, int footY, int scale, uint32_t nowMs, uint32_t seed);
// Screen position of the right hand for a pose (where props are held).
void char_hand(const Pose& p, int cx, int footY, int scale, int& hx, int& hy);
