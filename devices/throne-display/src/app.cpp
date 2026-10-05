#include "app.h"

#include "palette.h"
#include "ui_common.h"

App app;

static AgentAnim s_scratch[MAX_AGENTS];  // static to keep the loop task stack small

// Desk layout: one ring up to 12 agents, two staggered rings beyond that.
static void deskPosition(int i, int n, int16_t& x, int16_t& y) {
  int r, k, count, offset = 0;
  if (n <= 12) {
    r = n <= 6 ? 70 : 78;
    k = i;
    count = n;
  } else {
    int inner = n * 2 / 5;
    if (i < inner) {
      r = 56;
      k = i;
      count = inner;
    } else {
      r = 92;
      k = i - inner;
      count = n - inner;
      offset = 1024 / count / 2;
    }
  }
  if (count < 1) count = 1;
  int a = ui::ANG_TOP + offset + k * 1024 / count;
  // Skip the very top position on a single ring so the name arc / crown stay clear.
  if (n <= 12) a += 1024 / count / 2;
  int px, py;
  ui::polar(r, a, px, py);
  x = (int16_t)px;
  y = (int16_t)py;
}

int app_agentByHash(uint32_t idHash) {
  for (int i = 0; i < app.model.nAgents; i++)
    if (app.model.agents[i].idHash == idHash) return i;
  return -1;
}

void app_syncAnim(bool firstSync) {
  const Model& m = app.model;
  memcpy(s_scratch, app.anim, sizeof(s_scratch));
  static uint8_t s_prevCount = 0;
  uint8_t prevCount = s_prevCount;
  for (int i = 0; i < m.nAgents; i++) {
    const Agent& a = m.agents[i];
    AgentAnim& an = app.anim[i];
    int found = -1;
    for (int j = 0; j < prevCount; j++)
      if (s_scratch[j].idHash == a.idHash) {
        found = j;
        break;
      }
    if (found >= 0) {
      if (&an != &s_scratch[found]) memcpy(&an, &s_scratch[found], sizeof(AgentAnim));
    } else {
      memset(&an, 0, sizeof(an));
      an.idHash = a.idHash;
      genCharacter(a.idHash, an.spr);
      an.stateSince = app.now;
      an.lastState = a.state;
      an.lastHealth = a.health;
      an.lastTaskHash = a.taskHash;
    }
    an.ramp = pal::hueRamp(a.hue);
    deskPosition(i, m.nAgents, an.deskX, an.deskY);
    if (found < 0) {
      an.x = an.tx = an.deskX << 8;
      an.y = an.ty = an.deskY << 8;
    }
    if (an.lastState != a.state || an.lastHealth != a.health) {
      an.stateSince = app.now;
      an.lastState = a.state;
      an.lastHealth = a.health;
    }
    if (an.lastTaskHash && a.taskHash != an.lastTaskHash && !firstSync && found >= 0) {
      ui::spawnConfetti(an.x >> 8, (an.y >> 8) - 8, 22);
    }
    an.lastTaskHash = a.taskHash;
  }
  s_prevCount = m.nAgents;
  if (app.focus >= m.nAgents) app.focus = 0;
}

void app_update() {
  const Model& m = app.model;
  uint32_t dt = app.dt > 100 ? 100 : app.dt;
  for (int i = 0; i < m.nAgents; i++) {
    const Agent& a = m.agents[i];
    AgentAnim& an = app.anim[i];
    bool wander = a.state == S_IDLE && a.health != H_DOWN;
    if (wander) {
      if ((int32_t)(app.now - an.nextWander) >= 0) {
        // Pick a new spot on the floor, or take a breather.
        if (ui::rndRange(0, 4) == 0) {
          an.tx = an.x;
          an.ty = an.y;
        } else {
          int r = ui::rndRange(40, 100);
          int ang = ui::rndRange(0, 1024);
          int px, py;
          ui::polar(r, ang, px, py);
          an.tx = px << 8;
          an.ty = py << 8;
        }
        an.nextWander = app.now + ui::rndRange(2500, 6500);
      }
      int32_t dx = an.tx - an.x, dy = an.ty - an.y;
      int32_t dist = (int32_t)ui::isqrt((uint32_t)((dx >> 4) * (dx >> 4) + (dy >> 4) * (dy >> 4))) << 4;
      int32_t step = 20 * 256 * (int32_t)dt / 1000;  // 20 px/s
      if (dist > step && dist > 0) {
        an.x += dx * step / dist;
        an.y += dy * step / dist;
        an.walking = true;
        if (abs(dx) > 64) an.faceLeft = dx < 0;
      } else {
        an.x = an.tx;
        an.y = an.ty;
        an.walking = false;
      }
    } else {
      // Glide back to the desk.
      int32_t dx = (an.deskX << 8) - an.x, dy = (an.deskY << 8) - an.y;
      an.walking = abs(dx) + abs(dy) > 512;
      if (an.walking && abs(dx) > 64) an.faceLeft = dx < 0;
      an.x += dx / 6;
      an.y += dy / 6;
      if (abs(dx) < 64 && abs(dy) < 64) {
        an.x = an.deskX << 8;
        an.y = an.deskY << 8;
      }
    }
  }
  // Gentle bumping between wanderers.
  for (int i = 0; i < m.nAgents; i++) {
    if (m.agents[i].state != S_IDLE) continue;
    for (int j = i + 1; j < m.nAgents; j++) {
      if (m.agents[j].state != S_IDLE) continue;
      AgentAnim &a = app.anim[i], &b = app.anim[j];
      int32_t dx = (a.x - b.x) >> 8, dy = (a.y - b.y) >> 8;
      int d2 = dx * dx + dy * dy;
      if (d2 < 18 * 18) {
        int32_t px = dx == 0 && dy == 0 ? 1 : dx, py = dy;
        a.x += px * 24;
        a.y += py * 24;
        b.x -= px * 24;
        b.y -= py * 24;
      }
    }
  }
  // Keep everyone inside the room.
  for (int i = 0; i < m.nAgents; i++) {
    AgentAnim& an = app.anim[i];
    int32_t dx = (an.x >> 8) - ui::CX, dy = (an.y >> 8) - ui::CY;
    int32_t d2 = dx * dx + dy * dy;
    if (d2 > 102 * 102) {
      int32_t d = (int32_t)ui::isqrt((uint32_t)d2);
      an.x = (ui::CX + dx * 102 / d) << 8;
      an.y = (ui::CY + dy * 102 / d) << 8;
    }
  }
  ui::updateParticles(app.dt);
}

uint8_t healthRamp(uint8_t h) {
  switch (h) {
    case H_HEALTHY: return pal::GREEN;
    case H_ATTENTION: return pal::ORANGE;
    case H_DOWN: return pal::RED;
    default: return pal::AZURE;
  }
}

uint8_t stateRamp(uint8_t s) {
  switch (s) {
    case S_TYPING: return pal::VIOLET;
    case S_WORKING: return pal::CYAN;
    case S_OFFLINE: return pal::NEUTRAL;
    default: return pal::AZURE;
  }
}

const char* stateLabel(uint8_t s) {
  switch (s) {
    case S_TYPING: return "TYPING";
    case S_WORKING: return "WORKING";
    case S_OFFLINE: return "OFFLINE";
    default: return "IDLE";
  }
}

const char* healthLabel(uint8_t h) {
  switch (h) {
    case H_HEALTHY: return "healthy";
    case H_ATTENTION: return "needs attention";
    case H_DOWN: return "down";
    default: return "idle";
  }
}

void fmtAgo(char* out, size_t cap, int32_t sec) {
  if (sec < 0) {
    strlcpy(out, "never seen", cap);
  } else if (sec < 5) {
    strlcpy(out, "just now", cap);
  } else if (sec < 60) {
    snprintf(out, cap, "%lds ago", (long)sec);
  } else if (sec < 3600) {
    snprintf(out, cap, "%ldm ago", (long)(sec / 60));
  } else if (sec < 86400) {
    snprintf(out, cap, "%ldh ago", (long)(sec / 3600));
  } else {
    snprintf(out, cap, "%ldd ago", (long)(sec / 86400));
  }
}

int32_t app_snapshotAgeSec() { return (int32_t)((app.now - app.model.receivedMs) / 1000); }

bool app_hasRecentDm(const Agent& a) {
  return a.dmCount > 0 && a.dmNewestSec >= 0 && a.dmNewestSec + app_snapshotAgeSec() < DM_RECENT_SEC;
}

void drawDmBadge(int x, int y) {
  using pal::c;
  int p = ui::pulse(app.now, 1600);
  ui::glow(x, y, 9, pal::GOLD, 3 + p * 3 / 1024);
  ui::fillRect(x - 5, y - 3, 11, 8, c(pal::GOLD, 13));
  ui::rect(x - 5, y - 3, 11, 8, c(pal::GOLD, 6));
  // Flap.
  ui::line(x - 5, y - 3, x, y + 1, c(pal::GOLD, 6));
  ui::line(x + 5, y - 3, x, y + 1, c(pal::GOLD, 6));
}

void drawLock(int x, int y, uint8_t color) {
  // Shackle.
  ui::hline(x - 2, x + 2, y - 5, color);
  ui::fillRect(x - 3, y - 4, 1, 3, color);
  ui::fillRect(x + 3, y - 4, 1, 3, color);
  // Body with a keyhole.
  ui::fillRect(x - 4, y - 1, 9, 6, color);
  ui::px(x, y + 1, pal::BG);
  ui::px(x, y + 2, pal::BG);
}
