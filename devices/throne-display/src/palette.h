// 256-color indexed palette: 16 ramps x 16 brightness levels.
// index = (ramp << 4) | level. Ramp 0 is a cool neutral (index 0 is pure black),
// ramps 1..15 are hues spaced 24 degrees apart starting at red.
// Because every ramp is ordered dark -> bright, "max level" blending gives cheap glows.
#pragma once
#include <stdint.h>

#include "display_config.h"

namespace pal {

enum Ramp : uint8_t {
  NEUTRAL = 0,
  RED = 1,      // 0 deg
  ORANGE = 2,   // 24
  GOLD = 3,     // 48
  YELLOW = 4,   // 72
  LIME = 5,     // 96
  GREEN = 6,    // 120
  MINT = 7,     // 144
  TEAL = 8,     // 168
  CYAN = 9,     // 192
  AZURE = 10,   // 216
  BLUE = 11,    // 240
  VIOLET = 12,  // 264
  PURPLE = 13,  // 288
  MAGENTA = 14, // 312
  PINK = 15,    // 336
};

inline constexpr uint8_t c(uint8_t ramp, uint8_t level) { return (uint8_t)((ramp << 4) | (level & 15)); }
inline constexpr uint8_t level(uint8_t idx) { return idx & 15; }
inline constexpr uint8_t ramp(uint8_t idx) { return idx >> 4; }

// Map an agent hue (degrees) to the nearest hue ramp (1..15).
uint8_t hueRamp(int hueDeg);

// Common UI colors.
constexpr uint8_t BLACK = 0;
constexpr uint8_t BG = c(NEUTRAL, 1);
constexpr uint8_t WHITE = c(NEUTRAL, 15);
constexpr uint8_t TEXT = c(NEUTRAL, 14);
constexpr uint8_t TEXT_DIM = c(NEUTRAL, 9);
constexpr uint8_t TEXT_FAINT = c(NEUTRAL, 6);

void build();                                  // compute the base palette (once)
void apply(LGFX_Sprite& spr, int brightness);  // brightness 0..256, writes into sprite palette
uint32_t rgb(uint8_t idx);                     // base rgb888 for an index

}  // namespace pal
