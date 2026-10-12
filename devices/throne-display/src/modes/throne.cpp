// THRONE ROOM: a round pixel-art room viewed from above, "a tiny living office". The
// Emperor sits at the center; agents act out what they are doing at desks around a
// ring (typing on a laptop, writing, reviewing with a magnifier, presenting at a small
// board, thinking, talking), take idle breaks (coffee, stretch, nap), walk up to the
// front glass when they need you, and haunt their desks as ghosts when down / offline.
// Director mode draws this same scene and then zooms the frame.
#include "../app.h"
#include "../character.h"
#include "../moments.h"
#include "../palette.h"
#include "../sprites.h"
#include "../ui_common.h"

using namespace ui;
using pal::c;

// The Emperor: a human in gold robes (the crown is drawn on top).
static const Look kEmperor = {48, LOOK_HUMAN, 0, 2, 0, 4, ACC_NONE};

static void drawFloor() {
  clear(pal::BLACK);
  // Checkered stone floor clipped to the room.
  const uint8_t a = c(pal::NEUTRAL, 2), b = c(pal::NEUTRAL, 3);
  for (int y = 0; y < H; y++) {
    int hw = chordHalf(y, 1);
    if (!hw) continue;
    int x0 = CX - hw, x1 = CX + hw;
    int ty = (y + 4) / 20;
    for (int x = x0; x <= x1;) {
      int tx = (x + 4) / 20;
      int tileEnd = tx * 20 + 15;
      if (tileEnd > x1) tileEnd = x1;
      hline(x, tileEnd, y, ((tx + ty) & 1) ? a : b);
      x = tileEnd + 1;
    }
  }
  // Rug around the throne.
  fillCircle(CX, CY, 46, c(pal::PURPLE, 2));
  ring(CX, CY, 42, 44, c(pal::GOLD, 5));
  ring(CX, CY, 38, 38, c(pal::GOLD, 3));
  // Walls.
  ring(CX, CY, 112, 119, c(pal::NEUTRAL, 4));
  ring(CX, CY, 110, 111, c(pal::NEUTRAL, 6));
  circle(CX, CY, 112, c(pal::NEUTRAL, 7));
}

static void drawEmperor() {
  int flash = moments_crownFlash();
  int g = pulse(app.now, 3000);
  glow(CX, CY - 2, 34, pal::GOLD, 3 + g * 3 / 1024 + flash * 4 / 1024);
  drawThrone(CX, CY, 3);
  Pose p;
  memset(&p, 0, sizeof(p));
  p.expr = flash ? MOOD_HAPPY : MOOD_NEUTRAL;
  p.legs = LEGS_SEATED;
  p.arms = flash > 300 ? ARMS_UP : ARMS_DOWN;
  p.frame = (uint8_t)((app.now / 700) & 1);
  bool hit = false;
  if (moments_emperorKnock(&hit)) {
    // A need without an agent: the Emperor raps on the glass himself.
    p.arms = ARMS_KNOCK;
    p.frame = hit ? 1 : 0;
    p.expr = MOOD_NEUTRAL;
    if (hit) {
      int r = 3 + (int)((app.now / 30) % 5);
      circle(CX + 14, CY - 6, r, c(pal::NEUTRAL, 13));
      circle(CX + 14, CY - 6, r + 3, c(pal::NEUTRAL, 7));
    }
  }
  int bob = p.frame;
  char_draw(kEmperor, p, CX, CY + 16 + bob, 2, app.now, 0xC0FFEEu);
  int crownY = CY + 16 + bob - 36 - 3;
  if (flash) {
    glow(CX, crownY, 14 + flash / 64, pal::GOLD, 4 + flash * 10 / 1024);
    crownY -= flash * 4 / 1024;  // pops up, then settles
  }
  drawCrown(CX, crownY, flash > 600 ? 3 : 2);
}

// Desk whose top edge is at row y (the seated character's feet are hidden behind it).
static void drawDesk(int x, int y, int s) {
  const uint8_t top = c(pal::ORANGE, 6), edge = c(pal::ORANGE, 8), front = c(pal::ORANGE, 4), lo = c(pal::ORANGE, 2);
  fillRect(x - 11 * s, y - s, 22 * s, 2 * s, top);
  hline(x - 11 * s, x + 11 * s - 1, y - s, edge);
  fillRect(x - 11 * s, y + s, 22 * s, 4 * s, front);
  hline(x - 11 * s, x + 11 * s - 1, y + 5 * s - 1, lo);
  hline(x - 10 * s, x + 10 * s, y + 5 * s, c(pal::NEUTRAL, 1));  // shadow
}

static void drawAlert(int x, int y) {
  int bob = (isin((int)(app.now / 3) & 1023) * 3) >> 14;
  y += bob;
  glow(x, y, 8, pal::RED, 6);
  fillRect(x - 1, y - 6, 3, 7, c(pal::RED, 11));
  fillRect(x - 1, y + 3, 3, 2, c(pal::RED, 11));
}

static void drawSpeech(int x, int y, int s) {
  int w = 9 * s + 3, h = 5 * s + 3;
  fillRoundRect(x - w / 2, y - h / 2, w, h, 2 * s, pal::WHITE);
  fillRect(x - w / 2 + s, y + h / 2, s, s, pal::WHITE);
  int phase = (app.now / 220) % 4;
  for (int d = 0; d < 3; d++) {
    int lift = phase == d ? 1 : 0;
    fillRect(x - 3 * s + d * 3 * s - (s > 1 ? 0 : 0), y - lift - s / 2, s > 1 ? 2 : 1, s > 1 ? 2 : 1, c(pal::NEUTRAL, 3));
  }
}

static void drawThinkPuff(int x, int headY, int s) {
  int bx = x + 6 * s, by = headY - 3 * s;
  fillCircle(x + 2 * s, headY + s, s > 1 ? 1 : 0, pal::WHITE);
  fillCircle(x + 4 * s, headY - s, s, pal::WHITE);
  fillRoundRect(bx - 5 * s, by - 4 * s, 11 * s, 5 * s, 2 * s, pal::WHITE);
  int n = (int)((app.now / 350) % 4);
  for (int d = 0; d < n && d < 3; d++) fillRect(bx - 3 * s + d * 3 * s, by - 2 * s, s, s, c(pal::NEUTRAL, 3));
}

static void drawZzz(int x, int headY, int s) {
  for (int k = 0; k < 3; k++) {
    int ph = (int)((app.now / 45 + k * 12) % 36);
    int zx = x + 5 * s + ph / 4 + k * 2;
    int zy = headY - 2 - ph;
    uint8_t lv = (uint8_t)(15 - ph * 10 / 36);
    text(k == 1 ? "Z" : "z", zx, zy, c(pal::AZURE, lv), F_TINY);
  }
}

static void drawMug(int hx, int hy, int s) {
  fillRect(hx - s, hy - 2 * s, 2 * s + 1, 2 * s + 1, pal::WHITE);
  hline(hx - s, hx + s, hy - 2 * s, c(pal::ORANGE, 3));  // coffee
  px(hx + s + 1, hy - s, pal::WHITE);
  px(hx + s + 2, hy - s, pal::WHITE);
  px(hx + s + 2, hy - s + 1, pal::WHITE);
  // Steam.
  for (int k = 0; k < 2; k++) {
    for (int j = 0; j < 4 * s; j++) {
      int ph = (int)((app.now / 4 + j * 60 + k * 300) & 1023);
      int sx = hx - s / 2 + k * 2 + ((isin(ph) * 2) >> 14);
      int sy = hy - 3 * s - j - (int)((app.now / 90) % 3);
      pxMax(sx, sy, c(pal::NEUTRAL, (uint8_t)(10 - j * 6 / (4 * s))));
    }
  }
}

static void drawMagnifier(int hx, int hy, int s) {
  int wob = (isin((int)(app.now / 2) & 1023) * 2) >> 14;
  int lx = hx + 2 * s + wob, ly = hy - 3 * s;
  line(hx, hy, lx - s, ly + s, c(pal::ORANGE, 5));
  int r = 2 * s + 1;
  for (int dy = -r + 1; dy < r; dy++)
    for (int dx = -r + 1; dx < r; dx++)
      if (dx * dx + dy * dy < (r - 1) * (r - 1)) pxMax(lx + dx, ly + dy, c(pal::CYAN, 7));
  circle(lx, ly, r, c(pal::NEUTRAL, 13));
  px(lx - 1, ly - 1, pal::WHITE);
}

static void drawLaptop(int x, int y, int s, uint8_t ramp, uint32_t seed) {
  // Lid seen from behind; the screen light spills onto the face.
  int flick = (int)((app.now / 90 + seed) % 7);
  glow(x, y - 6 * s, 9 * s, pal::CYAN, 3 + (flick > 4 ? 2 : flick & 1));
  fillRect(x - 4 * s, y - 4 * s, 8 * s, 4 * s, c(pal::NEUTRAL, 5));
  hline(x - 4 * s, x + 4 * s - 1, y - 4 * s, c(pal::NEUTRAL, 8));
  int lp = pulse(app.now + seed, 1400);
  fillRect(x - s / 2 - (s > 1 ? 0 : 0), y - 3 * s + s / 2, s > 1 ? s : 1, s > 1 ? s : 1, c(ramp, (uint8_t)(9 + lp * 5 / 1024)));
}

static void drawPaper(int x, int y, int s, uint32_t since) {
  fillRect(x - 3 * s, y - s, 6 * s, 2 * s, pal::WHITE);
  int prog = (int)(((app.now - since) / 250) % (6 * s + 6));
  for (int l = 0; l < 2; l++) {
    int len = prog - l * 3 * s;
    if (len <= 0) continue;
    if (len > 5 * s) len = 5 * s;
    hline(x - 3 * s + 1, x - 3 * s + len, y - s + 1 + l * (s > 1 ? 2 : 1), c(pal::NEUTRAL, 6));
  }
}

static void drawBoard(int x, int y, int s, uint32_t since) {
  int w = 11 * s, h = 8 * s;
  int bx = x, by = y - h;
  line(bx + 2 * s, by + h, bx, y + 5 * s, c(pal::ORANGE, 4));  // easel legs
  line(bx + w - 2 * s, by + h, bx + w, y + 5 * s, c(pal::ORANGE, 4));
  fillRect(bx, by, w, h, pal::WHITE);
  rect(bx, by, w, h, c(pal::NEUTRAL, 6));
  // A bar chart that keeps growing.
  int t = (int)((app.now - since) % 3000);
  static const uint8_t kBars[3] = {pal::CYAN, pal::GOLD, pal::PINK};
  for (int k = 0; k < 3; k++) {
    int full = (2 + k * 2) * s;
    int bh = full * (t > 2400 ? 1024 : easeOutCubic(t * 1024 / 2400)) / 1024;
    fillRect(bx + s + k * 3 * s + 1, by + h - s - bh, 2 * s, bh, c(kBars[k], 10));
  }
}

void actor_anchor(int i, int& x, int& footY, int& scale) {
  const AgentAnim& an = app.anim[i];
  int s = app.charScale ? app.charScale : 2;
  x = an.x >> 8;
  footY = an.y >> 8;
  scale = an.atGlass ? s + 1 : s;  // pressed against the glass: closer to the viewer
  if (an.act == ACT_OFFLINE) {
    x = an.deskX;
    footY = an.deskY + 3 * s - 4 * s;
  }
}

void actor_draw(int i, int x, int footY, int s, bool seated) {
  const Agent& a = app.model.agents[i];
  const AgentAnim& an = app.anim[i];
  Pose p = app_pose(i);
  uint8_t act = an.act;
  int deskY = footY - 3 * s;  // top edge of the desk when seated

  if (act == ACT_OFFLINE) {
    if (seated) drawDesk(an.deskX, an.deskY, s);
    int fx = (isin((int)((app.now / 6 + an.idHash) & 1023)) * 4) >> 14;
    int fy = (isin((int)((app.now / 4 + an.idHash) & 1023)) * 3) >> 14;
    char_draw(an.look, p, x + fx, footY + fy, s, app.now, an.idHash);
    if (app_hasRecentDm(a)) drawDmBadge(x + 6 * s, footY - 14 * s);
    return;
  }

  int lift = 0;
  if (act == ACT_CELEBRATE) {
    int ph = (int)((app.now - an.actSince) % 560);
    lift = (isin(ph * 512 / 560) * 7 * s) >> 14;
  } else if (act == ACT_STRETCH) {
    lift = p.frame ? s / 2 + 1 : 0;
  }
  if (act == ACT_BLOCKED && app.now - an.actSince < 700) x += ((app.now / 45) & 1) ? 1 : -1;
  int fy = footY - lift;
  int headY = fy - 18 * s;

  if (act == ACT_PRESENTING) drawBoard(x + 7 * s, deskY - 2 * s, s, an.actSince);
  char_draw(an.look, p, x, fy, s, app.now, an.idHash);
  int hx, hy;
  char_hand(p, x, fy, s, hx, hy);
  if (seated) drawDesk(x, deskY, s);
  int propY = seated ? deskY : fy - 3 * s;
  switch (act) {
    case ACT_TYPING:
      drawLaptop(x, propY, s, an.ramp, an.idHash);
      if (seated && ui::rndRange(0, 12) == 0) spawnCode(x, propY - 5 * s, pal::LIME);
      break;
    case ACT_WRITING:
      drawPaper(x, propY, s, an.actSince);
      line(hx, hy, hx + s + 1, hy - 2 * s, c(pal::NEUTRAL, 3));  // pen
      break;
    case ACT_REVIEWING:
      if (seated) drawPaper(x - 4 * s, propY, s, an.actSince - 99999);
      drawMagnifier(hx, hy, s);
      break;
    case ACT_THINKING: drawThinkPuff(x, headY, s); break;
    case ACT_TALKING: drawSpeech(x + 8 * s, headY + s, s); break;
    case ACT_BLOCKED: drawAlert(x, headY - 8); break;
    case ACT_NAP: drawZzz(x, headY, s); break;
    case ACT_COFFEE: drawMug(hx, hy, s); break;
    default: break;
  }
  if (a.health == H_ATTENTION && act != ACT_BLOCKED) drawAlert(x - (act == ACT_TALKING ? 6 * s : 0), headY - 8);
  if (app_hasRecentDm(a)) drawDmBadge(x + 7 * s, headY + 4 * s);
  // A little twinkle when a paper plane lands.
  if (an.receiveUntil && (int32_t)(an.receiveUntil - app.now) > 0) {
    int k = (int)((app.now / 80) & 3);
    int sx = x - 6 * s + k * 4 * s, sy = headY - 2 - (k & 1) * 3;
    hline(sx - 2, sx + 2, sy, c(pal::GOLD, 14));
    fillRect(sx, sy - 2, 1, 5, c(pal::GOLD, 14));
  }
}

int throne_hit(int tx, int ty) {
  const Model& m = app.model;
  int best = -1, bestD = 0;
  for (int i = 0; i < m.nAgents; i++) {
    int x, footY, s;
    actor_anchor(i, x, footY, s);
    int y = footY - 10 * s;
    int r = 11 * s + 6;
    int d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
    if (d < r * r && (best < 0 || d < bestD)) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

void throne_draw(bool director) {
  const Model& m = app.model;
  int s = app.charScale ? app.charScale : 2;
  drawFloor();
  drawEmperor();

  // Painter's order by depth (screen y): empty desks and agents. A seated agent is
  // drawn together with its desk, which covers its legs.
  struct Item {
    int16_t key;
    uint8_t idx;
    uint8_t kind;  // 0 = agent (with desk if seated), 1 = empty desk
  };
  static Item items[MAX_AGENTS * 2];
  int n = 0;
  for (int i = 0; i < m.nAgents; i++) {
    const AgentAnim& an = app.anim[i];
    int x, footY, sc;
    actor_anchor(i, x, footY, sc);
    if (an.seated) {
      items[n++] = {(int16_t)(an.deskY + 5 * s), (uint8_t)i, 0};
    } else {
      items[n++] = {(int16_t)(an.deskY + 5 * s), (uint8_t)i, 1};
      items[n++] = {(int16_t)footY, (uint8_t)i, 0};
    }
  }
  for (int i = 1; i < n; i++) {
    Item t = items[i];
    int j = i - 1;
    while (j >= 0 && items[j].key > t.key) {
      items[j + 1] = items[j];
      j--;
    }
    items[j + 1] = t;
  }
  for (int k = 0; k < n; k++) {
    const AgentAnim& an = app.anim[items[k].idx];
    if (items[k].kind == 1) {
      drawDesk(an.deskX, an.deskY, s);
      continue;
    }
    int x, footY, sc;
    actor_anchor(items[k].idx, x, footY, sc);
    actor_draw(items[k].idx, x, footY, sc, an.seated);
  }

  // Names under the desks when there is room.
  if (m.nAgents <= 12) {
    char label[16];
    for (int i = 0; i < m.nAgents; i++) {
      const AgentAnim& an = app.anim[i];
      app_label(m.agents[i], label, sizeof(label), true);
      text(label, an.deskX, an.deskY + 5 * s + 6, c(an.ramp, 11), F_TINY);
    }
  }
  drawParticles();
  moments_drawWorld();
  if (!director) {
    moments_drawThroneBubble();
    moments_drawOverlay();
  }
}

bool throne_tap(int tx, int ty) {
  int best = throne_hit(tx, ty);
  if (best < 0) return false;
  app.focus = (uint8_t)best;
  return true;
}
