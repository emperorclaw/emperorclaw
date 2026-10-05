#include "ui_common.h"

#include <math.h>

namespace ui {

LGFX_Sprite* canvas = nullptr;
uint8_t* fb = nullptr;
int ox = 0, oy = 0;

static int16_t s_sin[1024];
static LGFX_Sprite s_glyph;  // 8-bit scratch sprite for rotated arc-text glyphs
static constexpr int GLYPH = 32;

void init(LGFX_Sprite* c) {
  canvas = c;
  fb = (uint8_t*)c->getBuffer();
  for (int i = 0; i < 1024; i++) s_sin[i] = (int16_t)lroundf(sinf(i * 2.0f * (float)M_PI / 1024.0f) * 16384.0f);
  s_glyph.setColorDepth(8);
  s_glyph.setPsram(false);
  s_glyph.createSprite(GLYPH, GLYPH);
}

int isin(int a) { return s_sin[a & 1023]; }
int icos(int a) { return s_sin[(a + 256) & 1023]; }

uint32_t isqrt(uint32_t v) {
  uint32_t r = 0, b = 1UL << 30;
  while (b > v) b >>= 2;
  while (b) {
    if (v >= r + b) {
      v -= r + b;
      r = (r >> 1) + b;
    } else {
      r >>= 1;
    }
    b >>= 2;
  }
  return r;
}

int chordHalf(int y, int margin) {
  int dy = y - CY;
  int r = RADIUS - margin;
  if (dy * dy >= r * r) return 0;
  return (int)isqrt((uint32_t)(r * r - dy * dy));
}

void polar(int r, int a, int& x, int& y, int cx, int cy) {
  x = cx + ((r * icos(a) + 8192) >> 14);
  y = cy + ((r * isin(a) + 8192) >> 14);
}

void clear(uint8_t c) { memset(fb, c, W * H); }

void hline(int x0, int x1, int y, uint8_t c) {
  y += oy;
  if ((unsigned)y >= (unsigned)H) return;
  x0 += ox;
  x1 += ox;
  if (x0 > x1) {
    int t = x0;
    x0 = x1;
    x1 = t;
  }
  if (x0 < 0) x0 = 0;
  if (x1 >= W) x1 = W - 1;
  if (x0 > x1) return;
  memset(fb + y * W + x0, c, x1 - x0 + 1);
}

void fillRect(int x, int y, int w, int h, uint8_t c) {
  for (int j = 0; j < h; j++) hline(x, x + w - 1, y + j, c);
}

void rect(int x, int y, int w, int h, uint8_t c) {
  hline(x, x + w - 1, y, c);
  hline(x, x + w - 1, y + h - 1, c);
  for (int j = 1; j < h - 1; j++) {
    px(x, y + j, c);
    px(x + w - 1, y + j, c);
  }
}

void fillRoundRect(int x, int y, int w, int h, int r, uint8_t c) {
  if (r * 2 > h) r = h / 2;
  if (r * 2 > w) r = w / 2;
  for (int j = 0; j < h; j++) {
    int inset = 0;
    int dy = 0;
    if (j < r) dy = r - j;
    else if (j >= h - r) dy = j - (h - r - 1);
    if (dy > 0) {
      int k = r * r - dy * dy;
      inset = r - (k > 0 ? (int)isqrt((uint32_t)k) : 0);
    }
    hline(x + inset, x + w - 1 - inset, y + j, c);
  }
}

void fillCircle(int cx, int cy, int r, uint8_t c) {
  for (int dy = -r; dy <= r; dy++) {
    int hw = (int)isqrt((uint32_t)(r * r - dy * dy + r));
    hline(cx - hw, cx + hw, cy + dy, c);
  }
}

void circle(int cx, int cy, int r, uint8_t c) {
  int x = r, y = 0, err = 1 - r;
  while (x >= y) {
    px(cx + x, cy + y, c);
    px(cx - x, cy + y, c);
    px(cx + x, cy - y, c);
    px(cx - x, cy - y, c);
    px(cx + y, cy + x, c);
    px(cx - y, cy + x, c);
    px(cx + y, cy - x, c);
    px(cx - y, cy - x, c);
    y++;
    if (err < 0) {
      err += 2 * y + 1;
    } else {
      x--;
      err += 2 * (y - x) + 1;
    }
  }
}

void ring(int cx, int cy, int r0, int r1, uint8_t c) {
  for (int dy = -r1; dy <= r1; dy++) {
    int ho = (int)isqrt((uint32_t)(r1 * r1 - dy * dy + r1));
    if (dy * dy < r0 * r0) {
      int hi = (int)isqrt((uint32_t)(r0 * r0 - dy * dy));
      hline(cx - ho, cx - hi, cy + dy, c);
      hline(cx + hi, cx + ho, cy + dy, c);
    } else {
      hline(cx - ho, cx + ho, cy + dy, c);
    }
  }
}

void arc(int cx, int cy, int r0, int r1, int a0, int a1, uint8_t c, bool maxBlend) {
  if (a1 < a0) return;
  if (a1 - a0 >= 1023) {
    if (!maxBlend) {
      ring(cx, cy, r0, r1, c);
      return;
    }
    a1 = a0 + 1023;
  }
  // Half-unit angle steps keep the outer edge gap-free up to r = 160.
  for (int s = a0 * 2; s <= a1 * 2; s++) {
    int a = s >> 1;
    int co, si;
    if (s & 1) {
      co = (icos(a) + icos(a + 1)) >> 1;
      si = (isin(a) + isin(a + 1)) >> 1;
    } else {
      co = icos(a);
      si = isin(a);
    }
    for (int r = r0; r <= r1; r++) {
      int x = cx + ((r * co + 8192) >> 14);
      int y = cy + ((r * si + 8192) >> 14);
      if (maxBlend) pxMax(x, y, c);
      else px(x, y, c);
    }
  }
}

void glow(int cx, int cy, int r, uint8_t rampId, int peak) {
  if (r <= 0 || peak <= 0) return;
  int r2 = r * r;
  for (int dy = -r; dy <= r; dy++) {
    for (int dx = -r; dx <= r; dx++) {
      int d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      int lv = peak - (peak * d2) / r2;
      if (lv > 0) pxMax(cx + dx, cy + dy, pal::c(rampId, (uint8_t)(lv > 15 ? 15 : lv)));
    }
  }
}

void line(int x0, int y0, int x1, int y1, uint8_t c, bool maxBlend) {
  int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  int err = dx + dy;
  for (;;) {
    if (maxBlend) pxMax(x0, y0, c);
    else px(x0, y0, c);
    if (x0 == x1 && y0 == y1) break;
    int e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

// ---------------------------------------------------------------- text

static const lgfx::IFont* fontPtr(Font f) {
  switch (f) {
    case F_TINY: return &fonts::Font0;
    case F_SMALL: return &fonts::Font2;
    case F_MED: return &fonts::FreeSansBold9pt7b;
    case F_BIG: return &fonts::FreeSansBold12pt7b;
    default: return &fonts::FreeSansBold24pt7b;
  }
}

void setFont(Font f) { canvas->setFont(fontPtr(f)); }

int textWidth(const char* s, Font f) {
  canvas->setFont(fontPtr(f));
  return canvas->textWidth(s);
}

int fontHeight(Font f) {
  canvas->setFont(fontPtr(f));
  return canvas->fontHeight();
}

void text(const char* s, int x, int y, uint8_t c, Font f, lgfx::textdatum_t datum) {
  canvas->setFont(fontPtr(f));
  canvas->setTextDatum(datum);
  canvas->setTextColor((uint32_t)c);
  canvas->drawString(s, x + ox, y + oy);
}

void textFit(const char* s, int x, int y, int maxW, uint8_t c, Font f, lgfx::textdatum_t datum) {
  canvas->setFont(fontPtr(f));
  if (canvas->textWidth(s) <= maxW) {
    text(s, x, y, c, f, datum);
    return;
  }
  char buf[132];
  size_t n = strlen(s);
  if (n > 120) n = 120;
  while (n > 0) {
    n--;
    memcpy(buf, s, n);
    while (n > 0 && buf[n - 1] == ' ') n--;
    memcpy(buf + n, "...", 4);
    if (canvas->textWidth(buf) <= maxW || n == 0) {
      text(buf, x, y, c, f, datum);
      return;
    }
  }
}

int wrapText(const char* s, int maxW, Font f, uint16_t* starts, uint8_t* lens, int maxLines) {
  canvas->setFont(fontPtr(f));
  int lines = 0;
  int len = strlen(s);
  int pos = 0;
  char buf[128];
  while (pos < len && lines < maxLines) {
    while (pos < len && s[pos] == ' ') pos++;
    if (pos >= len) break;
    int best = -1;  // exclusive end index of the best break
    for (int i = pos; i <= len; i++) {
      if (i == len || s[i] == ' ') {
        int n = i - pos;
        if (n > 126) break;
        memcpy(buf, s + pos, n);
        buf[n] = 0;
        if (canvas->textWidth(buf) <= maxW) best = i;
        else break;
      }
    }
    if (best < 0) {
      // A single word wider than the line: hard break by characters.
      int n = 1;
      while (pos + n < len && n < 126) {
        memcpy(buf, s + pos, n + 1);
        buf[n + 1] = 0;
        if (canvas->textWidth(buf) > maxW) break;
        n++;
      }
      best = pos + n;
    }
    starts[lines] = (uint16_t)pos;
    int l = best - pos;
    lens[lines] = (uint8_t)(l > 255 ? 255 : l);
    lines++;
    pos = best;
  }
  return lines;
}

void arcText(const char* s, int radius, int centerAngle, uint8_t c, Font f, bool top) {
  const lgfx::IFont* fp = fontPtr(f);
  canvas->setFont(fp);
  s_glyph.setFont(fp);
  s_glyph.setTextDatum(lgfx::middle_center);
  int n = strlen(s);
  if (n == 0) return;
  int total = canvas->textWidth(s);
  int circ = (int)(2 * 314 * radius / 100);  // circumference in pixels
  if (circ <= 0) return;
  int span = total * 1024 / circ;
  int dir = top ? 1 : -1;
  int start = centerAngle - dir * span / 2;
  int acc = 0;
  char ch[2] = {0, 0};
  const int half = GLYPH / 2;
  for (int i = 0; i < n; i++) {
    ch[0] = s[i];
    int cw = canvas->textWidth(ch);
    int mid = acc + cw / 2;
    acc += cw;
    if (s[i] == ' ') continue;
    int a = start + dir * (mid * 1024 / circ);
    int gx, gy;
    polar(radius, a, gx, gy);
    // Glyph "up" points outward on top arcs and inward on bottom arcs.
    int rot = top ? a + 256 : a - 256;
    s_glyph.fillScreen((uint8_t)0);
    s_glyph.setTextColor((uint8_t)0xFF);
    s_glyph.drawString(ch, half, half);
    const uint8_t* g = (const uint8_t*)s_glyph.getBuffer();
    int cs = icos(rot), sn = isin(rot);
    for (int dy = -half; dy < half; dy++) {
      for (int dx = -half; dx < half; dx++) {
        // Inverse-rotate the destination offset into glyph space.
        int sx = ((dx * cs + dy * sn) >> 14) + half;
        int sy = ((-dx * sn + dy * cs) >> 14) + half;
        if ((unsigned)sx < (unsigned)GLYPH && (unsigned)sy < (unsigned)GLYPH && g[sy * GLYPH + sx])
          px(gx + dx, gy + dy, c);
      }
    }
  }
}

// ---------------------------------------------------------------- easing

int easeOutCubic(int t) {
  if (t <= 0) return 0;
  if (t >= 1024) return 1024;
  int64_t u = 1024 - t;
  return 1024 - (int)((u * u * u) >> 20);
}

int easeInOutCubic(int t) {
  if (t <= 0) return 0;
  if (t >= 1024) return 1024;
  if (t < 512) return (int)(((int64_t)4 * t * t * t) >> 20);
  int64_t u = 2048 - 2 * (int64_t)t;  // (2 - 2t) in Q10
  return 1024 - (int)((u * u * u) >> 21);
}

int easeOutBack(int t) {
  if (t <= 0) return 0;
  if (t >= 1024) return 1024;
  // 1 + c3*(t-1)^3 + c1*(t-1)^2 with c1 = 1.70158, c3 = c1 + 1
  int64_t u = t - 1024;
  const int64_t c1 = 1742, c3 = 2766;  // Q10
  return 1024 + (int)((c3 * u * u * u) >> 30) + (int)((c1 * u * u) >> 20);
}

int pulse(uint32_t nowMs, uint32_t periodMs) {
  uint32_t p = nowMs % periodMs;
  int a = (int)((uint64_t)p * 1024 / periodMs);
  return (isin(a) + 16384) >> 5;  // 0..1024
}

// ---------------------------------------------------------------- particles

struct Particle {
  int16_t x, y, vx, vy;  // Q4 position, Q4/2 per 16 ms velocity
  uint16_t life, maxLife;
  uint8_t color;
  uint8_t kind;  // 0 confetti, 1 code spark
};
static Particle s_parts[72];

static uint32_t s_rng = 0x9E3779B9u;
uint32_t rnd() {
  s_rng ^= s_rng << 13;
  s_rng ^= s_rng >> 17;
  s_rng ^= s_rng << 5;
  return s_rng;
}
int rndRange(int lo, int hi) { return hi <= lo ? lo : lo + (int)(rnd() % (uint32_t)(hi - lo)); }

static Particle* allocParticle() {
  Particle* oldest = &s_parts[0];
  for (auto& p : s_parts) {
    if (p.life == 0) return &p;
    if (p.life < oldest->life) oldest = &p;
  }
  return oldest;
}

void clearParticles() {
  for (auto& p : s_parts) p.life = 0;
}

void spawnConfetti(int x, int y, int count) {
  static const uint8_t ramps[] = {pal::GOLD, pal::PINK, pal::CYAN, pal::LIME, pal::VIOLET, pal::ORANGE};
  for (int i = 0; i < count; i++) {
    Particle* p = allocParticle();
    int a = rndRange(0, 1024);
    int sp = rndRange(14, 40);
    p->x = (int16_t)(x << 4);
    p->y = (int16_t)(y << 4);
    p->vx = (int16_t)((sp * icos(a)) >> 14);
    p->vy = (int16_t)(((sp * isin(a)) >> 14) - 28);
    p->maxLife = p->life = (uint16_t)rndRange(700, 1300);
    p->color = pal::c(ramps[i % 6], (uint8_t)rndRange(10, 14));
    p->kind = 0;
  }
}

void spawnCode(int x, int y, uint8_t rampId) {
  Particle* p = allocParticle();
  p->x = (int16_t)((x + rndRange(-5, 6)) << 4);
  p->y = (int16_t)(y << 4);
  p->vx = (int16_t)rndRange(-3, 4);
  p->vy = (int16_t)-rndRange(6, 14);
  p->maxLife = p->life = (uint16_t)rndRange(500, 900);
  p->color = pal::c(rampId, 12);
  p->kind = 1;
}

void updateParticles(uint32_t dtMs) {
  int steps = dtMs / 16;
  if (steps < 1) steps = 1;
  if (steps > 4) steps = 4;
  for (auto& p : s_parts) {
    if (!p.life) continue;
    for (int s = 0; s < steps; s++) {
      p.x += p.vx / 2;
      p.y += p.vy / 2;
      if (p.kind == 0) {
        p.vy += 2;                     // gravity
        p.vx = (int16_t)(p.vx * 15 / 16);  // drag
      }
    }
    p.life = p.life > dtMs ? (uint16_t)(p.life - dtMs) : 0;
  }
}

void drawParticles() {
  for (auto& p : s_parts) {
    if (!p.life) continue;
    int x = p.x >> 4, y = p.y >> 4;
    int fade = p.life * 16 / p.maxLife;  // 0..16
    uint8_t lv = (uint8_t)((p.color & 15) * (fade + 4) / 20);
    uint8_t col = (uint8_t)((p.color & 0xF0) | lv);
    if (p.kind == 0) {
      px(x, y, col);
      if ((p.life / 90) & 1) px(x + 1, y, col);  // tumbling flake
      else px(x, y + 1, col);
    } else {
      pxMax(x, y, col);
      pxMax(x, y + 1, (uint8_t)((col & 0xF0) | (lv / 2)));
    }
  }
}

}  // namespace ui
