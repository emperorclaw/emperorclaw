// THRONE ROOM: a round pixel-art room viewed from above. The Emperor sits at the center;
// agents work at desks around a ring, wander the floor when idle, and haunt their desks
// as ghosts when down or offline.
#include "../app.h"
#include "../palette.h"
#include "../sprites.h"
#include "../ui_common.h"

using namespace ui;
using pal::c;

static CharSprite s_emperor;
static bool s_emperorReady = false;

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
  if (!s_emperorReady) {
    genCharacter(0xC0FFEEu, s_emperor);
    s_emperorReady = true;
  }
  int g = pulse(app.now, 3000);
  glow(CX, CY - 2, 34, pal::GOLD, 3 + g * 3 / 1024);
  fillCircle(CX, CY + 2, 24, c(pal::PURPLE, 3));
  circle(CX, CY + 2, 24, c(pal::GOLD, 8));
  drawThrone(CX, CY + 2, 2);
  int bob = (app.now / 700) & 1;
  drawCharacter(s_emperor, bob, CX, CY + 2 + bob, 2, pal::GOLD, CF_NONE, app.now);
  drawCrown(CX, CY - 15 + bob, 2);
}

static void drawDesk(int x, int y, bool active, uint32_t seed) {
  // Monitor (to the right, sitting on the desk) and desk top.
  const uint8_t wood = c(pal::ORANGE, 4), woodHi = c(pal::ORANGE, 6), woodLo = c(pal::ORANGE, 2);
  fillRect(x - 12, y + 3, 31, 7, wood);
  hline(x - 12, x + 18, y + 3, woodHi);
  hline(x - 12, x + 18, y + 9, woodLo);
  // Monitor
  fillRect(x + 9, y - 5, 10, 8, c(pal::NEUTRAL, 2));
  uint8_t screen;
  if (active) {
    int flick = (int)((app.now / 90 + seed) % 7);
    screen = c(pal::CYAN, (uint8_t)(9 + (flick > 4 ? 2 : flick & 1)));
    glow(x + 14, y - 1, 12, pal::CYAN, 4);
  } else {
    screen = c(pal::NEUTRAL, 3);
  }
  fillRect(x + 10, y - 4, 8, 6, screen);
  if (active) {
    // Scrolling "code" lines on the screen.
    int off = (app.now / 160 + seed) % 3;
    for (int l = 0; l < 3; l++) {
      int w = 2 + (int)((seed >> (l * 3)) + l + off) % 5;
      hline(x + 11, x + 11 + w, y - 3 + ((l + off) % 3) * 2, c(pal::CYAN, 14));
    }
  }
  px(x + 14, y + 3, c(pal::NEUTRAL, 5));  // stand
}

static void drawTypingBubble(int x, int y) {
  fillRoundRect(x - 9, y - 6, 19, 11, 4, pal::WHITE);
  px(x - 3, y + 5, pal::WHITE);
  px(x - 4, y + 6, pal::WHITE);
  int phase = (app.now / 220) % 4;
  for (int d = 0; d < 3; d++) {
    int lift = (phase == d) ? 1 : 0;
    fillRect(x - 5 + d * 4, y - 1 - lift, 2, 2, c(pal::NEUTRAL, 3));
  }
}

static void drawAlert(int x, int y) {
  int bob = (isin((int)(app.now / 3) & 1023) * 3) >> 14;
  y += bob;
  glow(x, y, 8, pal::RED, 6);
  fillRect(x - 1, y - 6, 3, 7, c(pal::RED, 11));
  fillRect(x - 1, y + 3, 3, 2, c(pal::RED, 11));
}

void throne_draw() {
  const Model& m = app.model;
  drawFloor();
  // Desks first (agents at desks are drawn on top, then the desk front covers their legs).
  for (int i = 0; i < m.nAgents; i++) {
    const AgentAnim& an = app.anim[i];
    bool active = m.agents[i].state == S_WORKING || m.agents[i].state == S_TYPING;
    drawDesk(an.deskX, an.deskY, active && m.agents[i].health != H_DOWN, an.idHash);
  }
  drawEmperor();

  for (int i = 0; i < m.nAgents; i++) {
    const Agent& a = m.agents[i];
    AgentAnim& an = app.anim[i];
    int x = an.x >> 8, y = an.y >> 8;
    bool ghost = a.health == H_DOWN || a.state == S_OFFLINE;
    bool atDesk = !ghost && !an.walking && a.state != S_IDLE;
    if (ghost) {
      int fx = (isin((int)((app.now / 6 + an.idHash) & 1023)) * 4) >> 14;
      int fy = (isin((int)((app.now / 4 + an.idHash) & 1023)) * 3) >> 14;
      drawCharacter(an.spr, 0, an.deskX + fx, an.deskY - 8 + fy, 2, an.ramp, CF_GHOST, app.now);
    } else {
      int frame;
      if (an.walking) frame = (app.now / 170) & 1;
      else if (a.state == S_WORKING || a.state == S_TYPING) frame = (app.now / 260) & 1;
      else frame = ((app.now + an.idHash) / 900) & 1;
      int bob = (!an.walking && frame) ? 1 : 0;
      drawCharacter(an.spr, frame, x, y - 6 + bob, 2, an.ramp, an.faceLeft ? CF_FLIP : CF_NONE, app.now);
      if (atDesk) {
        // Desk front over the legs.
        fillRect(an.deskX - 12, an.deskY + 3, 21, 7, c(pal::ORANGE, 4));
        hline(an.deskX - 12, an.deskX + 8, an.deskY + 3, c(pal::ORANGE, 6));
        hline(an.deskX - 12, an.deskX + 8, an.deskY + 9, c(pal::ORANGE, 2));
        if (a.state == S_WORKING && ui::rndRange(0, 9) == 0) spawnCode(an.deskX + 14, an.deskY - 6, pal::LIME);
      }
    }
    int headY = (ghost ? an.deskY - 8 : y - 6) - 18;
    int headX = ghost ? an.deskX : x;
    if (a.state == S_TYPING && !ghost) drawTypingBubble(headX + 6, headY);
    if (a.health == H_ATTENTION) drawAlert(headX - (a.state == S_TYPING ? 8 : 0), headY);
    if (app_hasRecentDm(a)) drawDmBadge(headX + 12, headY + 12);
  }

  // Names under the desks when there is room.
  if (m.nAgents <= 12) {
    for (int i = 0; i < m.nAgents; i++) {
      const AgentAnim& an = app.anim[i];
      text(m.agents[i].shortName, an.deskX, an.deskY + 15, c(an.ramp, 11), F_TINY);
    }
  }
  drawParticles();
}

bool throne_tap(int tx, int ty) {
  const Model& m = app.model;
  int best = -1, bestD = 22 * 22;
  for (int i = 0; i < m.nAgents; i++) {
    const AgentAnim& an = app.anim[i];
    bool ghost = m.agents[i].health == H_DOWN || m.agents[i].state == S_OFFLINE;
    int x = ghost ? an.deskX : an.x >> 8;
    int y = ghost ? an.deskY - 8 : (an.y >> 8) - 4;
    int d = (x - tx) * (x - tx) + (y - ty) * (y - ty);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return false;
  app.focus = (uint8_t)best;
  return true;
}
