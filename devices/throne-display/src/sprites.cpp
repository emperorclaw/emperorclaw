#include "sprites.h"

#include "palette.h"
#include "ui_common.h"

// Cell codes
enum : uint8_t {
  C_EMPTY = 0,
  C_OUTLINE = 1,
  C_BODY = 2,
  C_LIGHT = 3,
  C_ACCENT = 4,
  C_EYE = 5,
  C_DARK = 6,
  C_SHADE = 7,
};

namespace {

struct Rng {
  uint32_t s;
  explicit Rng(uint32_t seed) : s(seed ? seed : 0xA5A5A5A5u) {
    for (int i = 0; i < 4; i++) next();
  }
  uint32_t next() {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return s;
  }
  int range(int n) { return (int)(next() % (uint32_t)n); }
  bool coin() { return next() & 0x100; }
};

// Write a cell and its mirror. hc = half column 0..5 (5 is next to the center line).
inline void setM(uint8_t g[CHAR_N][CHAR_N], int row, int hc, uint8_t v) {
  if (row < 0 || row >= CHAR_N || hc < 0 || hc > 5) return;
  g[row][hc] = v;
  g[row][11 - hc] = v;
}

bool solid(uint8_t v) { return v != C_EMPTY && v != C_OUTLINE; }

void shadeAndOutline(uint8_t g[CHAR_N][CHAR_N]) {
  uint8_t src[CHAR_N][CHAR_N];
  memcpy(src, g, sizeof(src));
  for (int y = 0; y < CHAR_N; y++) {
    for (int x = 0; x < CHAR_N; x++) {
      uint8_t v = src[y][x];
      if (v == C_BODY) {
        bool topOpen = y == 0 || !solid(src[y - 1][x]);
        bool botOpen = y == CHAR_N - 1 || !solid(src[y + 1][x]);
        if (topOpen) g[y][x] = C_LIGHT;
        else if (botOpen) g[y][x] = C_SHADE;
      } else if (v == C_EMPTY) {
        bool n = (y > 0 && solid(src[y - 1][x])) || (y < CHAR_N - 1 && solid(src[y + 1][x])) ||
                 (x > 0 && solid(src[y][x - 1])) || (x < CHAR_N - 1 && solid(src[y][x + 1]));
        if (n) g[y][x] = C_OUTLINE;
      }
    }
  }
}

}  // namespace

void genCharacter(uint32_t seed, CharSprite& out) {
  out.seed = seed;
  Rng r(seed);
  uint8_t g[CHAR_N][CHAR_N];
  memset(g, 0, sizeof(g));

  // Head
  int headTop = 1 + r.range(2);  // 1..2
  int headW = 3 + r.range(3);    // half-width 3..5
  int headL = 6 - headW;         // leftmost half column
  for (int y = headTop; y <= 5; y++)
    for (int c = headL; c <= 5; c++) setM(g, y, c, C_BODY);
  if (headW >= 4 && r.coin()) {  // rounded corners
    setM(g, headTop, headL, C_EMPTY);
    setM(g, 5, headL, C_EMPTY);
  }

  // Head decoration
  switch (r.range(6)) {
    case 1:  // antennae
      setM(g, headTop - 1, headL + 1, C_ACCENT);
      if (headTop == 2) setM(g, 0, headL + 1, C_ACCENT);
      break;
    case 2:  // ears
      setM(g, headTop - 1, headL, C_BODY);
      break;
    case 3:  // hair band
      for (int c = headL; c <= 5; c++) setM(g, headTop, c, C_ACCENT);
      if (headTop == 2) setM(g, 1, 5, C_ACCENT), setM(g, 1, 4, C_ACCENT);
      break;
    case 4:  // horns
      setM(g, headTop - 1, headL, C_ACCENT);
      if (headTop == 2) setM(g, 0, headL > 0 ? headL - 1 : 0, C_ACCENT);
      break;
    case 5:  // single crest
      setM(g, headTop - 1, 5, C_ACCENT);
      break;
    default:
      break;
  }

  // Eyes
  int eyeRow = headTop + 1 + r.range(2);
  if (eyeRow > 4) eyeRow = 4;
  int eyeCol = 3 + r.range(2);
  if (eyeCol < headL) eyeCol = headL;
  int eyeStyle = r.range(3);
  if (eyeStyle == 2) {  // visor
    for (int c = headL; c <= 5; c++) setM(g, eyeRow, c, C_ACCENT);
    setM(g, eyeRow, eyeCol, C_EYE);
  } else {
    setM(g, eyeRow, eyeCol, C_EYE);
    if (eyeStyle == 1 && eyeRow + 1 <= 5) setM(g, eyeRow + 1, eyeCol, C_DARK);
  }
  if (r.coin() && eyeRow < 4) setM(g, 5, 5, C_DARK);  // mouth

  // Body
  int bodyW = 2 + r.range(3);  // 2..4
  int bodyL = 6 - bodyW;
  for (int y = 6; y <= 8; y++)
    for (int c = bodyL; c <= 5; c++) setM(g, y, c, C_BODY);
  switch (r.range(3)) {
    case 0:
      for (int c = bodyL; c <= 5; c++) setM(g, 8, c, C_ACCENT);  // belt
      break;
    case 1:
      setM(g, 7, 5, C_ACCENT);  // emblem
      break;
    default:
      break;
  }
  // Arms
  if (bodyL >= 2 && r.range(4) != 0) {
    setM(g, 6, bodyL - 1, C_BODY);
    setM(g, 7, bodyL - 1, C_BODY);
  }
  // Legs
  int legCol = bodyW >= 3 ? 3 + r.range(2) : 4;
  setM(g, 9, legCol, C_BODY);
  setM(g, 10, legCol, C_BODY);

  // Frame A
  memcpy(out.px[0], g, sizeof(g));
  shadeAndOutline(out.px[0]);

  // Frame B: left leg lifted, right arm raised.
  g[10][legCol] = C_EMPTY;
  if (bodyL >= 2 && g[7][11 - (bodyL - 1)] == C_BODY) {
    g[7][11 - (bodyL - 1)] = C_EMPTY;
    g[5][11 - (bodyL - 1)] = C_BODY;
  }
  memcpy(out.px[1], g, sizeof(g));
  shadeAndOutline(out.px[1]);
}

void drawCharacter(const CharSprite& s, int frame, int cx, int cy, int scale, uint8_t ramp, uint8_t flags,
                   uint32_t nowMs) {
  using namespace pal;
  bool ghost = flags & CF_GHOST;
  uint8_t R = ghost ? (uint8_t)NEUTRAL : ramp;
  uint8_t A = ghost ? (uint8_t)NEUTRAL : (uint8_t)(((ramp - 1 + 7) % 15) + 1);
  int dim = (flags & CF_DIM) ? 2 : 0;
  uint8_t map[8];
  map[C_EMPTY] = 0;
  map[C_OUTLINE] = c(R, ghost ? 4 : 2);
  map[C_BODY] = c(R, (uint8_t)((ghost ? 9 : 9) - dim));
  map[C_LIGHT] = c(R, (uint8_t)((ghost ? 11 : 12) - dim));
  map[C_ACCENT] = c(A, (uint8_t)((ghost ? 10 : 11) - dim));
  map[C_EYE] = c(NEUTRAL, 15);
  map[C_DARK] = c(NEUTRAL, 1);
  map[C_SHADE] = c(R, (uint8_t)((ghost ? 6 : 6) - dim));

  // Blink: briefly close the eyes every few seconds (stagger by seed).
  bool blink = ((nowMs + (s.seed & 0xFFF)) % 3600) < 130;

  const uint8_t(*g)[CHAR_N] = s.px[frame & 1];
  int x0 = cx - CHAR_N * scale / 2;
  int y0 = cy - CHAR_N * scale / 2;
  int dither = (nowMs / 120) & 1;
  for (int y = 0; y < CHAR_N; y++) {
    for (int x = 0; x < CHAR_N; x++) {
      uint8_t v = g[y][(flags & CF_FLIP) ? (CHAR_N - 1 - x) : x];
      if (v == C_EMPTY) continue;
      uint8_t col = map[v];
      if (v == C_EYE && blink) col = map[C_SHADE];
      int px0 = x0 + x * scale, py0 = y0 + y * scale;
      if (ghost && v != C_EYE) {
        // Checkerboard dither at screen-pixel level for translucency.
        for (int j = 0; j < scale; j++)
          for (int i = 0; i < scale; i++)
            if (((px0 + i + py0 + j + dither) & 1) == 0) ui::px(px0 + i, py0 + j, col);
        continue;
      }
      if (scale == 1) {
        ui::px(px0, py0, col);
      } else {
        for (int j = 0; j < scale; j++) ui::hline(px0, px0 + scale - 1, py0 + j, col);
      }
    }
  }
}

// ---------------------------------------------------------------- fixed art

static uint8_t artColor(char ch) {
  using namespace pal;
  switch (ch) {
    case 'G': return c(GOLD, 11);
    case 'g': return c(GOLD, 7);
    case 'Y': return c(YELLOW, 14);
    case 'P': return c(PURPLE, 4);
    case 'V': return c(PURPLE, 8);
    case 'v': return c(PURPLE, 6);
    case 'R': return c(RED, 10);
    case 'B': return c(AZURE, 12);
    case 'K': return c(NEUTRAL, 2);
    case 'W': return c(NEUTRAL, 15);
    default: return 0;
  }
}

static void drawArt(const char* const* rows, int nRows, int cx, int cy, int scale) {
  int w = strlen(rows[0]);
  int x0 = cx - w * scale / 2;
  int y0 = cy - nRows * scale / 2;
  for (int y = 0; y < nRows; y++) {
    for (int x = 0; x < w; x++) {
      uint8_t col = artColor(rows[y][x]);
      if (!col) continue;
      int px0 = x0 + x * scale, py0 = y0 + y * scale;
      for (int j = 0; j < scale; j++) ui::hline(px0, px0 + scale - 1, py0 + j, col);
    }
  }
}

static const char* const kThrone[] = {
    "...KGGGGGGGGGK...",
    "..KGgggggggggGK..",
    "..KgVVVVVVVVVgK..",
    "..KgVvVVVVVvVgK..",
    "..KgVVVVVVVVVgK..",
    "..KgVvVVVVVvVgK..",
    "..KgVVVVVVVVVgK..",
    "KKKgVVVVVVVVVgKKK",
    "KGGgVVVVVVVVVgGGK",
    "KGgPPPPPPPPPPPgGK",
    "KGgVVVVVVVVVVVgGK",
    "KGgPPPPPPPPPPPgGK",
    "KGGGGGGGGGGGGGGGK",
    ".Kg.K.......K.gK.",
    ".KK.K.......K.KK.",
};

void drawThrone(int cx, int cy, int scale) { drawArt(kThrone, sizeof(kThrone) / sizeof(kThrone[0]), cx, cy, scale); }

static const char* const kCrown[] = {
    "Y...Y...Y",
    "GG.GGG.GG",
    "GGGGGGGGG",
    "GRGGBGGRG",
    "ggggggggg",
};

void drawCrown(int cx, int cy, int scale) { drawArt(kCrown, 5, cx, cy, scale); }
