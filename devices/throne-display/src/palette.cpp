#include "palette.h"

#include <math.h>

#include "display_config.h"

namespace pal {

static uint8_t s_r[256], s_g[256], s_b[256];
static int s_lastBrightness = -1;

static void hsv(float h, float s, float v, uint8_t& r, uint8_t& g, uint8_t& b) {
  h = fmodf(h, 360.0f);
  if (h < 0) h += 360.0f;
  float c = v * s;
  float x = c * (1 - fabsf(fmodf(h / 60.0f, 2) - 1));
  float m = v - c;
  float rr = 0, gg = 0, bb = 0;
  if (h < 60) {
    rr = c;
    gg = x;
  } else if (h < 120) {
    rr = x;
    gg = c;
  } else if (h < 180) {
    gg = c;
    bb = x;
  } else if (h < 240) {
    gg = x;
    bb = c;
  } else if (h < 300) {
    rr = x;
    bb = c;
  } else {
    rr = c;
    bb = x;
  }
  r = (uint8_t)lroundf((rr + m) * 255);
  g = (uint8_t)lroundf((gg + m) * 255);
  b = (uint8_t)lroundf((bb + m) * 255);
}

void build() {
  for (int L = 0; L < 16; L++) {
    // Neutral ramp: deep navy blacks rising to a cool white. Index 0 is pure black.
    float t = L / 15.0f;
    float v = L == 0 ? 0.0f : 0.035f + 0.965f * powf(t, 1.55f);
    float s = 0.42f * (1.0f - t) + 0.04f;
    hsv(228.0f, s, v, s_r[L], s_g[L], s_b[L]);
    for (int rp = 1; rp < 16; rp++) {
      float hue = (rp - 1) * 24.0f;
      float vv, ss;
      if (L <= 10) {
        vv = 0.05f + 0.95f * powf(L / 10.0f, 1.3f);
        ss = 0.9f;
      } else {
        vv = 1.0f;
        ss = 0.9f * (1.0f - (L - 10) / 6.0f);  // L15 -> tinted white
      }
      int i = (rp << 4) | L;
      hsv(hue, ss, vv, s_r[i], s_g[i], s_b[i]);
    }
  }
}

uint8_t hueRamp(int hueDeg) {
  hueDeg %= 360;
  if (hueDeg < 0) hueDeg += 360;
  int r = (hueDeg + 12) / 24;  // 0..15
  if (r >= 15) r = 0;
  return (uint8_t)(1 + r);
}

uint32_t rgb(uint8_t idx) { return ((uint32_t)s_r[idx] << 16) | ((uint32_t)s_g[idx] << 8) | s_b[idx]; }

void apply(LGFX_Sprite& spr, int brightness) {
  if (brightness < 0) brightness = 0;
  if (brightness > 256) brightness = 256;
  if (brightness == s_lastBrightness) return;
  s_lastBrightness = brightness;
  for (int i = 0; i < 256; i++) {
    spr.setPaletteColor(i, (uint8_t)((s_r[i] * brightness) >> 8), (uint8_t)((s_g[i] * brightness) >> 8),
                        (uint8_t)((s_b[i] * brightness) >> 8));
  }
}

}  // namespace pal
