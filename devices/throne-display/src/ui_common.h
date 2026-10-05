// Shared rendering helpers that write straight into the 8-bit indexed frame buffer.
// Angles use a 1024-unit "binary degree" circle: 0 = 3 o'clock, 256 = 6 o'clock
// (clockwise, because screen Y grows downwards), 768 = 12 o'clock.
#pragma once
#include <Arduino.h>

#include "display_config.h"
#include "palette.h"

namespace ui {

constexpr int W = 240, H = 240, CX = 120, CY = 120, RADIUS = 120;
constexpr int ANG_FULL = 1024, ANG_TOP = 768, ANG_BOTTOM = 256, ANG_RIGHT = 0, ANG_LEFT = 512;

extern LGFX_Sprite* canvas;
extern uint8_t* fb;
extern int ox, oy;  // global draw offset (used by mode transitions)

void init(LGFX_Sprite* c);

// Q14 sine / cosine from a 1024-entry table.
int isin(int a);
int icos(int a);
uint32_t isqrt(uint32_t v);

// Chord half-width of the visible circle at screen row y (0 outside).
int chordHalf(int y, int margin = 0);

inline void px(int x, int y, uint8_t c) {
  x += ox;
  y += oy;
  if ((unsigned)x < (unsigned)W && (unsigned)y < (unsigned)H) fb[y * W + x] = c;
}
// Only overwrite when the new color is brighter (glow-style blend).
inline void pxMax(int x, int y, uint8_t c) {
  x += ox;
  y += oy;
  if ((unsigned)x < (unsigned)W && (unsigned)y < (unsigned)H) {
    uint8_t& d = fb[y * W + x];
    if ((c & 15) > (d & 15)) d = c;
  }
}

void clear(uint8_t c);
void hline(int x0, int x1, int y, uint8_t c);
void fillRect(int x, int y, int w, int h, uint8_t c);
void rect(int x, int y, int w, int h, uint8_t c);
void fillRoundRect(int x, int y, int w, int h, int r, uint8_t c);
void fillCircle(int cx, int cy, int r, uint8_t c);
void circle(int cx, int cy, int r, uint8_t c);
void ring(int cx, int cy, int r0, int r1, uint8_t c);
// Annulus segment from angle a0 to a1 (a1 >= a0, may exceed 1024).
void arc(int cx, int cy, int r0, int r1, int a0, int a1, uint8_t c, bool maxBlend = false);
// Radial max-blend glow in one ramp.
void glow(int cx, int cy, int r, uint8_t ramp, int peakLevel);
void line(int x0, int y0, int x1, int y1, uint8_t c, bool maxBlend = false);
void polar(int r, int a, int& x, int& y, int cx = CX, int cy = CY);

// Text (LovyanGFX fonts rendered into the indexed canvas).
enum Font : uint8_t { F_TINY, F_SMALL, F_MED, F_BIG, F_HUGE };
void setFont(Font f);
int textWidth(const char* s, Font f);
int fontHeight(Font f);
void text(const char* s, int x, int y, uint8_t c, Font f, lgfx::textdatum_t datum = lgfx::middle_center);
// Text along an arc. top=true reads clockwise along the top; false reads along the bottom.
void arcText(const char* s, int radius, int centerAngle, uint8_t c, Font f, bool top);
// Word wrap. Returns line count; fills start offsets / lengths.
int wrapText(const char* s, int maxW, Font f, uint16_t* starts, uint8_t* lens, int maxLines);
// Draw text truncated with "..." to fit maxW.
void textFit(const char* s, int x, int y, int maxW, uint8_t c, Font f,
             lgfx::textdatum_t datum = lgfx::middle_center);

// Easing, t in 0..1024 -> 0..1024.
int easeOutCubic(int t);
int easeInOutCubic(int t);
int easeOutBack(int t);
// Smooth sine pulse 0..1024 with the given period.
int pulse(uint32_t nowMs, uint32_t periodMs);

// Particles (confetti, code sparks).
void spawnConfetti(int x, int y, int count = 18);
void spawnCode(int x, int y, uint8_t ramp);
void updateParticles(uint32_t dtMs);
void drawParticles();
void clearParticles();

// Small xorshift PRNG (UI only).
uint32_t rnd();
int rndRange(int lo, int hi);  // inclusive lo, exclusive hi

}  // namespace ui
