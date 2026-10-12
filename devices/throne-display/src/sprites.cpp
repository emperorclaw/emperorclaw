#include "sprites.h"

#include "palette.h"
#include "ui_common.h"

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
