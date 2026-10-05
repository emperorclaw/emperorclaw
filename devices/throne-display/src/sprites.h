// Procedural 12x12 pixel-art characters, seeded deterministically from an agent id hash.
// The left half is generated and mirrored (identicon / space-invader style), then shaded
// and outlined automatically. Two frames: A (rest) and B (step / bob).
#pragma once
#include <Arduino.h>

constexpr int CHAR_N = 12;

struct CharSprite {
  uint32_t seed;
  uint8_t px[2][CHAR_N][CHAR_N];  // cell codes, see sprites.cpp
};

enum CharFlags : uint8_t {
  CF_NONE = 0,
  CF_GHOST = 1,  // grey, dithered translucency
  CF_FLIP = 2,   // mirror horizontally (walking left)
  CF_DIM = 4,    // darker (inactive / far)
};

void genCharacter(uint32_t seed, CharSprite& out);
// Draw centered at (cx, cy). scale = 1..4. ramp = agent hue ramp (pal::hueRamp).
void drawCharacter(const CharSprite& s, int frame, int cx, int cy, int scale, uint8_t ramp, uint8_t flags = CF_NONE,
                   uint32_t nowMs = 0);

// Fixed pixel art for the throne room.
void drawThrone(int cx, int cy, int scale);
void drawCrown(int cx, int cy, int scale);
