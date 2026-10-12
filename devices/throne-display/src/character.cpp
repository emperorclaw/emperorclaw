#include "character.h"

#include "palette.h"
#include "ui_common.h"

// Logical grid: x = -8..7 (0 is just right of the center line), y = -20..-1 (feet on
// row -1). Every body part is drawn twice: pass 0 paints it grown by one screen pixel
// in the outline color, pass 1 paints the fill, so the union of all parts gets a clean
// 1-pixel outline at any scale. Small details (eyes, mouth, panels) only use pass 1.

namespace {

// Web palette (src/lib/character/model.ts), mapped to the nearest palette index in char_init().
const uint32_t kSkinRgb[6] = {0xf7d7bd, 0xecc19c, 0xd8a074, 0xb97e52, 0x8a5738, 0x5f3a25};
const uint32_t kHairRgb[8] = {0x241a15, 0x4b2f1e, 0x8a5a2b, 0xd9a441, 0xe9d29a, 0x6f2f2f, 0x334155, 0x9b8aa6};
const uint16_t kHues[12] = {190, 205, 265, 150, 38, 340, 210, 95, 20, 300, 170, 250};
const uint8_t kAccessories[7] = {ACC_NONE, ACC_GLASSES, ACC_HEADSET, ACC_CAP, ACC_BOW, ACC_NONE, ACC_NONE};

uint8_t s_skin[6], s_skinShade[6], s_hair[8], s_hairShade[8];

// Draw state for the character being painted.
int s_cx, s_fy, s_sc;
bool s_flip, s_ghost;
uint8_t s_pass;
uint8_t s_outline;
int s_dither;

uint8_t nearest(uint32_t rgb) {
  int r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  uint32_t best = 0xFFFFFFFFu;
  uint8_t bi = 0;
  for (int i = 1; i < 256; i++) {
    uint32_t p = pal::rgb((uint8_t)i);
    int dr = (int)((p >> 16) & 255) - r, dg = (int)((p >> 8) & 255) - g, db = (int)(p & 255) - b;
    uint32_t d = (uint32_t)(2 * dr * dr + 4 * dg * dg + 3 * db * db);
    if (d < best) {
      best = d;
      bi = (uint8_t)i;
    }
  }
  return bi;
}

uint8_t darker(uint8_t idx, int by) {
  int lv = (idx & 15) - by;
  return (uint8_t)((idx & 0xF0) | (lv < 1 ? 1 : lv));
}

void fill(int sx, int sy, int w, int h, uint8_t col) {
  if (!s_ghost) {
    ui::fillRect(sx, sy, w, h, col);
    return;
  }
  // Checkerboard dither at screen-pixel level reads as translucency.
  for (int j = 0; j < h; j++)
    for (int i = (sx + sy + j + s_dither) & 1; i < w; i += 2) ui::px(sx + i, sy + j, col);
}

// Silhouette rect (outlined).
void R(int x, int y, int w, int h, uint8_t col) {
  if (w <= 0 || h <= 0) return;
  if (s_flip) x = -x - w;
  int sx = s_cx + x * s_sc, sy = s_fy + y * s_sc;
  if (s_pass == 0) {
    if (!s_ghost) ui::fillRect(sx - 1, sy - 1, w * s_sc + 2, h * s_sc + 2, s_outline);
    return;
  }
  fill(sx, sy, w * s_sc, h * s_sc, col);
}

// Detail rect (fill pass only, never outlined).
void D(int x, int y, int w, int h, uint8_t col) {
  if (s_pass == 0 || w <= 0 || h <= 0) return;
  if (s_flip) x = -x - w;
  fill(s_cx + x * s_sc, s_fy + y * s_sc, w * s_sc, h * s_sc, col);
}

// Rounded block: `cut` cells trimmed off the corners (0 = square, 1, 2 = round).
void RR(int x, int y, int w, int h, int cut, uint8_t col, bool detail = false) {
  for (int j = 0; j < h; j++) {
    int in = 0;
    if (cut >= 1 && (j == 0 || j == h - 1)) in = cut;
    else if (cut >= 2 && (j == 1 || j == h - 2)) in = 1;
    if (detail) D(x + in, y + j, w - 2 * in, 1, col);
    else R(x + in, y + j, w - 2 * in, 1, col);
  }
}

// Eyes at left x = lx (2 cells), right x = rx, top row ey.
void eyes(uint8_t expr, int lx, int rx, int ey, uint8_t col, uint32_t now, uint32_t seed) {
  int shift = 0;
  if (expr == MOOD_SCANNING) {
    int ph = (int)((now / 3 + seed) & 1023);
    int s = ui::isin(ph);
    shift = s > 7000 ? 1 : (s < -7000 ? -1 : 0);
  }
  bool blink = ((now + (seed & 0xFFF)) % 3700) < 120;
  switch (expr) {
    case MOOD_HAPPY:  // upturned arcs
      D(lx - 1, ey + 1, 1, 1, col);
      D(lx, ey, 2, 1, col);
      D(lx + 2, ey + 1, 1, 1, col);
      D(rx - 1, ey + 1, 1, 1, col);
      D(rx, ey, 2, 1, col);
      D(rx + 2, ey + 1, 1, 1, col);
      return;
    case MOOD_SLEEPY:  // closed, low
      D(lx, ey + 1, 2, 1, col);
      D(rx, ey + 1, 2, 1, col);
      return;
    case MOOD_FOCUSED:  // narrowed under a flat brow
      D(lx, ey - 1, 2, 1, col);
      D(rx, ey - 1, 2, 1, col);
      D(lx, ey + 1, 2, 1, col);
      D(rx, ey + 1, 2, 1, col);
      return;
    default:
      break;
  }
  if (blink) {
    D(lx + shift, ey + 1, 2, 1, col);
    D(rx + shift, ey + 1, 2, 1, col);
  } else {
    D(lx + shift, ey, 2, 2, col);
    D(rx + shift, ey, 2, 2, col);
  }
  if (expr == MOOD_WORRIED) {
    // Brows tilt up toward the middle: concerned, not angry.
    D(lx, ey - 1, 1, 1, col);
    D(lx + 1, ey - 2, 1, 1, col);
    D(rx, ey - 2, 1, 1, col);
    D(rx + 1, ey - 1, 1, 1, col);
  }
}

// Mouth centered on the grid's center line at row my.
void mouth(uint8_t expr, int my, uint8_t col) {
  switch (expr) {
    case MOOD_HAPPY:
      D(-3, my - 1, 1, 1, col);
      D(-2, my, 4, 1, col);
      D(2, my - 1, 1, 1, col);
      break;
    case MOOD_WORRIED:
      D(-2, my, 1, 1, col);
      D(-1, my - 1, 2, 1, col);
      D(1, my, 1, 1, col);
      break;
    case MOOD_FOCUSED:
    case MOOD_SCANNING:
    case MOOD_SLEEPY:
      D(-1, my, 2, 1, col);
      break;
    default:  // gentle smile
      D(-2, my - 1, 1, 1, col);
      D(-1, my, 2, 1, col);
      D(1, my - 1, 1, 1, col);
      break;
  }
}

void arms(const Pose& p, uint8_t arm, uint8_t hand) {
  int f = p.frame & 1;
  // Left arm (screen left when not flipped).
  switch (p.arms) {
    case ARMS_UP:
      R(-8, -12 - f, 2, 5, arm);
      R(-8, -13 - f, 2, 1, hand);
      break;
    case ARMS_TYPE:
      R(-7, -8, 2, 3, arm);
      R(-6, -5 - f, 2, 1, hand);
      break;
    default:
      R(-7, -8, 2, 4, arm);
      R(-7, -4, 2, 1, hand);
      break;
  }
  // Right arm.
  switch (p.arms) {
    case ARMS_UP:
      R(6, -12 - (f ^ 1), 2, 5, arm);
      R(6, -13 - (f ^ 1), 2, 1, hand);
      break;
    case ARMS_TYPE:
      R(5, -8, 2, 3, arm);
      R(4, -5 - (f ^ 1), 2, 1, hand);
      break;
    case ARMS_POINT:
      R(5, -8, 4, 2, arm);
      R(9, -8, 1, 2, hand);
      break;
    case ARMS_HOLD:
      R(5, -8, 2, 2, arm);
      R(4, -7, 2, 1, hand);
      break;
    case ARMS_KNOCK:
      R(5, -11 + f, 2, 4, arm);
      R(5, -12 + f, 2, 1, hand);
      break;
    case ARMS_THROW:
      R(6, -13, 2, 5, arm);
      R(6, -14, 2, 1, hand);
      break;
    default:
      R(5, -8, 2, 4, arm);
      R(5, -4, 2, 1, hand);
      break;
  }
}

void legs(const Pose& p, uint8_t leg, uint8_t shoe) {
  if (p.legs == LEGS_SEATED) return;
  int f = p.legs == LEGS_WALK ? (p.frame & 3) : 0;
  int liftL = f == 1 ? 1 : 0, liftR = f == 3 ? 1 : 0;
  R(-4, -2 - liftL, 3, 1, leg);
  R(-4, -1 - liftL, 3, 1, shoe);
  R(1, -2 - liftR, 3, 1, leg);
  R(1, -1 - liftR, 3, 1, shoe);
}

void accessory(const Look& L, bool robot, uint8_t ramp, int ey) {
  switch (L.acc) {
    case ACC_GLASSES: {
      uint8_t fr = robot ? pal::c(pal::NEUTRAL, 14) : pal::c(pal::NEUTRAL, 2);
      for (int side = 0; side < 2; side++) {
        int x = side ? 1 : -5;
        D(x, ey - 1, 4, 1, fr);
        D(x, ey + 2, 4, 1, fr);
        D(x, ey, 1, 2, fr);
        D(x + 3, ey, 1, 2, fr);
      }
      D(-1, ey, 2, 1, fr);
      break;
    }
    case ACC_HEADSET: {
      uint8_t dark = pal::c(pal::NEUTRAL, 4);
      R(-6, -19, 12, 1, dark);
      R(-8, -15, 2, 4, dark);
      D(-8, -14, 1, 2, pal::c(ramp, 11));
      D(-6, -11, 1, 1, dark);
      D(-5, -10, 2, 1, dark);
      break;
    }
    case ACC_CAP: {
      R(-6, -20, 12, 3, pal::c(ramp, 9));
      D(-6, -18, 12, 1, pal::c(ramp, 6));
      R(5, -18, 4, 1, pal::c(ramp, 6));  // brim
      D(-1, -20, 2, 1, pal::c(ramp, 6));
      break;
    }
    case ACC_BOW: {
      uint8_t pink = pal::c(pal::PINK, 11);
      R(1, -20, 2, 2, pink);
      R(4, -20, 2, 2, pink);
      D(3, -20, 1, 2, pal::c(pal::PINK, 7));
      break;
    }
    default:
      break;
  }
}

void robot(const Look& L, const Pose& p, uint32_t now, uint32_t seed) {
  using pal::c;
  uint8_t rp = s_ghost ? (uint8_t)pal::NEUTRAL : pal::hueRamp(L.hue);
  uint8_t shell = s_ghost ? c(pal::NEUTRAL, 9) : c(rp, 14);
  uint8_t shellHi = c(pal::NEUTRAL, 15);
  uint8_t shellShade = s_ghost ? c(pal::NEUTRAL, 7) : c(pal::NEUTRAL, 11);
  uint8_t accent = s_ghost ? c(pal::NEUTRAL, 7) : c(rp, 9);
  uint8_t accentDark = s_ghost ? c(pal::NEUTRAL, 5) : c(rp, 6);
  uint8_t visor = s_ghost ? c(pal::NEUTRAL, 3) : c(rp, 1);
  uint8_t glow = s_ghost ? c(pal::NEUTRAL, 8) : c(rp, 12);
  uint8_t light = p.expr == MOOD_FOCUSED ? c(pal::GOLD, 13) : glow;
  if (!s_ghost && ((now + seed) % 2400) < 1200) light = darker(light, 2);  // slow blink
  int v = L.variant & 3;

  legs(p, shellShade, accentDark);
  // Antenna (one with a bulb, or two for variant 1).
  if (v == 1) {
    R(-5, -19, 1, 1, accentDark);
    R(4, -19, 1, 1, accentDark);
    R(-6, -20, 2, 1, light);
    R(4, -20, 2, 1, light);
  } else {
    R(-1, -19, 2, 1, accentDark);
    R(-1, -20, 2, 1, light);
  }
  bool armsOver = p.arms == ARMS_UP || p.arms == ARMS_KNOCK || p.arms == ARMS_THROW;
  if (!armsOver) arms(p, shell, accent);
  // Torso with chest panel and light.
  RR(-5, -8, 10, 6, 1, shell);
  D(-4, -3, 8, 1, shellShade);
  D(-2, -7, 4, 3, accent);
  D(-1, -6, 2, 1, light);
  // Ear discs.
  R(-8, -15, 1, 3, accent);
  R(7, -15, 1, 3, accent);
  // Head shell, highlight and visor. Variant sets the roundness, like headRx on the web.
  static const uint8_t kCut[4] = {1, 2, 0, 1};
  RR(-7, -18, 14, 10, kCut[v], shell);
  D(-4, -17, 8, 1, shellHi);
  D(-6, -10, 12, 1, shellShade);
  RR(-5, -16, 10, 6, v == 2 ? 0 : 1, visor, true);
  eyes(p.expr, -4, 2, -15, glow, now, seed);
  if (!s_ghost && p.expr != MOOD_SLEEPY) {
    D(-5, -12, 1, 1, c(pal::PINK, p.expr == MOOD_HAPPY ? 11 : 8));
    D(4, -12, 1, 1, c(pal::PINK, p.expr == MOOD_HAPPY ? 11 : 8));
  }
  mouth(p.expr, -11, glow);
  if (armsOver) arms(p, shell, accent);
  accessory(L, true, rp, -15);
}

void hairBack(int style, uint8_t hair) {
  switch (style) {
    case 1: R(-7, -17, 14, 9, hair); break;   // long
    case 3: R(-2, -20, 4, 2, hair); break;    // bun
    case 5: R(-8, -18, 16, 8, hair); break;   // curly volume
    default: break;
  }
}

void hairFront(int style, uint8_t hair, uint8_t shade) {
  switch (style) {
    case 1:  // long with curtain bangs
      R(-4, -18, 8, 1, hair);
      R(-6, -17, 12, 2, hair);
      R(-6, -15, 3, 1, hair);
      R(3, -15, 3, 1, hair);
      R(-7, -15, 1, 7, hair);
      R(6, -15, 1, 7, hair);
      break;
    case 2:  // short spiky
      R(-4, -19, 1, 1, hair);
      R(-1, -20, 1, 2, hair);
      R(2, -19, 1, 1, hair);
      R(-4, -18, 8, 1, hair);
      R(-6, -17, 12, 2, hair);
      R(-6, -15, 2, 1, hair);
      R(-2, -15, 1, 1, hair);
      R(3, -15, 3, 1, hair);
      break;
    case 3:  // bun with a neat fringe
      R(-4, -18, 8, 1, hair);
      R(-6, -17, 12, 3, hair);
      D(-4, -15, 8, 1, shade);
      break;
    case 4:  // buzz cut
      R(-4, -18, 8, 1, hair);
      R(-6, -17, 12, 1, hair);
      break;
    case 5:  // curls
      R(-5, -20, 10, 1, hair);
      R(-7, -19, 14, 1, hair);
      R(-8, -18, 16, 3, hair);
      R(-8, -15, 2, 4, hair);
      R(6, -15, 2, 4, hair);
      D(-5, -19, 1, 1, shade);
      D(1, -18, 1, 1, shade);
      D(-3, -17, 1, 1, shade);
      D(4, -16, 1, 1, shade);
      break;
    default:  // side-swept
      R(-4, -18, 8, 1, hair);
      R(-6, -17, 12, 2, hair);
      R(-6, -15, 5, 1, hair);
      R(-6, -14, 1, 2, hair);
      R(5, -15, 1, 2, hair);
      break;
  }
}

void human(const Look& L, const Pose& p, uint32_t now, uint32_t seed) {
  using pal::c;
  uint8_t rp = s_ghost ? (uint8_t)pal::NEUTRAL : pal::hueRamp(L.hue);
  uint8_t skin = s_ghost ? c(pal::NEUTRAL, 10) : s_skin[L.skin % 6];
  uint8_t skinShade = s_ghost ? c(pal::NEUTRAL, 8) : s_skinShade[L.skin % 6];
  uint8_t hair = s_ghost ? c(pal::NEUTRAL, 6) : s_hair[L.hairColor & 7];
  uint8_t hairShade = s_ghost ? c(pal::NEUTRAL, 5) : s_hairShade[L.hairColor & 7];
  uint8_t shirt = s_ghost ? c(pal::NEUTRAL, 8) : c(rp, 8);
  uint8_t shirtShade = s_ghost ? c(pal::NEUTRAL, 6) : c(rp, 6);
  uint8_t ink = s_ghost ? c(pal::NEUTRAL, 4) : c(pal::NEUTRAL, 1);
  uint8_t white = c(pal::NEUTRAL, s_ghost ? 11 : 15);
  int style = L.hairStyle % 6;

  legs(p, c(pal::NEUTRAL, 5), c(pal::NEUTRAL, 2));
  hairBack(style, hair);
  bool armsOver = p.arms == ARMS_UP || p.arms == ARMS_KNOCK || p.arms == ARMS_THROW;
  if (!armsOver) arms(p, shirt, skin);
  // Torso, collar and lanyard badge.
  RR(-5, -8, 10, 6, 1, shirt);
  D(-4, -3, 8, 1, shirtShade);
  D(-2, -8, 4, 1, white);
  D(-1, -7, 2, 1, white);
  D(2, -5, 2, 1, c(rp, 11));
  D(2, -4, 2, 1, white);
  // Ears and head.
  R(-7, -13, 1, 2, skin);
  R(6, -13, 1, 2, skin);
  RR(-6, -17, 12, 9, 2, skin);
  D(-3, -9, 6, 1, skinShade);
  hairFront(style, hair, hairShade);
  eyes(p.expr, -4, 2, -13, ink, now, seed);
  if (!s_ghost) {
    uint8_t blush = c(pal::PINK, p.expr == MOOD_HAPPY ? 12 : 13);
    D(-5, -11, 1, 1, blush);
    D(4, -11, 1, 1, blush);
  }
  mouth(p.expr, -10, s_ghost ? ink : c(pal::RED, 5));
  if (armsOver) arms(p, shirt, skin);
  accessory(L, false, rp, -13);
}

}  // namespace

void char_init() {
  for (int i = 0; i < 6; i++) {
    s_skin[i] = nearest(kSkinRgb[i]);
    s_skinShade[i] = darker(s_skin[i], 2);
  }
  for (int i = 0; i < 8; i++) {
    s_hair[i] = nearest(kHairRgb[i]);
    s_hairShade[i] = darker(s_hair[i], 2);
  }
}

void char_derive(uint32_t h, uint16_t hue, Look& out) {
  // Same picks as deriveAppearance(): kind h%3, variant >>3, skin >>6, hair >>9, accessory >>12.
  // The firmware's fnv1a() matches the web's hashString() for ASCII ids. The feed's own
  // `hue` wins over the derived one so v1 servers keep their colors.
  out.kind = (h % 3 == 0) ? LOOK_HUMAN : LOOK_ROBOT;
  out.hue = hue < 360 ? hue : kHues[h % 12];
  out.variant = (uint8_t)((h >> 3) % 4);
  out.skin = (uint8_t)((h >> 6) % 6);
  uint8_t hair = (uint8_t)((h >> 9) % 6);
  out.hairColor = hair;                                    // HAIR_COLORS[hair % 8]
  out.hairStyle = (uint8_t)((hair + out.variant) % 4);     // draw.ts: (hair + variant) % 4
  out.acc = kAccessories[(h >> 12) % 7];
}

void char_draw(const Look& L, const Pose& p, int cx, int footY, int scale, uint32_t nowMs, uint32_t seed) {
  if (scale < 1) scale = 1;
  s_cx = cx;
  s_fy = footY;
  s_sc = scale;
  s_flip = p.flip;
  s_ghost = p.ghost;
  s_dither = (int)((nowMs / 120) & 1);
  s_outline = pal::c(pal::NEUTRAL, 1);
  for (s_pass = 0; s_pass < 2; s_pass++) {
    if (s_ghost && s_pass == 0) continue;
    if (L.kind == LOOK_HUMAN) human(L, p, nowMs, seed);
    else robot(L, p, nowMs, seed);
  }
}

void char_hand(const Pose& p, int cx, int footY, int scale, int& hx, int& hy) {
  int lx, ly;
  switch (p.arms) {
    case ARMS_TYPE: lx = 5; ly = -5; break;
    case ARMS_UP: lx = 7; ly = -13; break;
    case ARMS_POINT: lx = 9; ly = -7; break;
    case ARMS_HOLD: lx = 5; ly = -7; break;
    case ARMS_KNOCK: lx = 6; ly = -12 + (p.frame & 1); break;
    case ARMS_THROW: lx = 7; ly = -14; break;
    default: lx = 6; ly = -4; break;
  }
  if (p.flip) lx = -lx - 1;
  hx = cx + lx * scale + scale / 2;
  hy = footY + ly * scale + scale / 2;
}
