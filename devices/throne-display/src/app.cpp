#include "app.h"

#include <Preferences.h>

#include "moments.h"
#include "palette.h"
#include "ui_common.h"

App app;

static AgentAnim s_scratch[MAX_AGENTS];  // static to keep the loop task stack small

static inline bool active(uint32_t until) { return until && (int32_t)(until - app.now) > 0; }

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
  app.charScale = m.nAgents <= 8 ? 2 : 1;
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
      an.stateSince = app.now;
      an.actSince = app.now;
      an.lastState = a.state;
      an.lastHealth = a.health;
      an.lastTaskHash = a.taskHash;
    }
    // The feed's look when present (v2), else one derived from the id like the web does.
    if (a.look.kind != LOOK_NONE) an.look = a.look;
    else char_derive(a.idHash, a.hue, an.look);
    an.ramp = pal::hueRamp(an.look.hue);
    deskPosition(i, m.nAgents, an.deskX, an.deskY);
    if (found < 0) {
      an.x = an.tx = an.deskX << 8;
      an.y = an.ty = (an.deskY + 3 * app.charScale) << 8;
    }
    if (an.lastState != a.state || an.lastHealth != a.health) {
      an.stateSince = app.now;
      an.lastState = a.state;
      an.lastHealth = a.health;
    }
    // v1 servers have no task_done events: a changed / cleared task id is the cue.
    if (m.version < 2 && an.lastTaskHash && a.taskHash != an.lastTaskHash && !firstSync && found >= 0) {
      ui::spawnConfetti(an.x >> 8, (an.y >> 8) - 12 * app.charScale, 22);
      an.celebrateUntil = app.now + 2400;
    }
    an.lastTaskHash = a.taskHash;
  }
  s_prevCount = m.nAgents;
  if (app.focus >= m.nAgents) app.focus = 0;
  moments_sync(firstSync);
}

// ---------------------------------------------------------------- acting

static uint8_t baseAct(const Agent& a) {
  if (a.health == H_DOWN || a.state == S_OFFLINE) return ACT_OFFLINE;
  if (a.act != ACT_AUTO) return a.act;
  switch (a.state) {
    case S_TYPING: return ACT_TALKING;  // v1 "typing" = writing a chat message
    case S_WORKING: return ACT_TYPING;
    default: return ACT_IDLE;
  }
}

// Idle agents wander, and every 24-36 s (per-agent seed) take a 9 s break:
// a coffee, a stretch or a nap at the desk.
static uint8_t idleRoutine(const AgentAnim& an) {
  uint32_t seed = an.idHash;
  uint32_t period = 24000 + seed % 12000;
  uint32_t t = app.now + (seed >> 8) % period;
  uint32_t ph = t % period, cyc = t / period;
  if (ph < period - 9000) return ACT_IDLE;
  switch ((cyc + (seed >> 4)) % 3) {
    case 0: return ACT_COFFEE;
    case 1: return ph < period - 5000 ? ACT_STRETCH : ACT_IDLE;
    default: return ACT_NAP;
  }
}

static uint8_t resolveAct(const Agent& a, const AgentAnim& an) {
  uint8_t act = baseAct(a);
  if (act == ACT_OFFLINE) return act;
  if (active(an.knockUntil)) return ACT_WAITING;
  if (active(an.celebrateUntil)) return ACT_CELEBRATE;
  if (active(an.blockedUntil)) return ACT_BLOCKED;
  if (act == ACT_IDLE) act = idleRoutine(an);
  return act;
}

static uint8_t resolveMood(const Agent& a, const AgentAnim& an, uint8_t act) {
  switch (act) {
    case ACT_CELEBRATE: return MOOD_HAPPY;
    case ACT_BLOCKED: return MOOD_WORRIED;
    case ACT_NAP:
    case ACT_OFFLINE: return MOOD_SLEEPY;
    default: break;
  }
  if (active(an.receiveUntil)) return MOOD_HAPPY;
  if (a.mood != MOOD_AUTO) return a.mood;
  if (a.health == H_ATTENTION) return MOOD_WORRIED;
  switch (act) {
    case ACT_TYPING:
    case ACT_WRITING: return MOOD_FOCUSED;
    case ACT_REVIEWING: return MOOD_SCANNING;
    case ACT_PRESENTING:
    case ACT_TALKING:
    case ACT_COFFEE:
    case ACT_STRETCH: return MOOD_HAPPY;
    default: return MOOD_NEUTRAL;
  }
}

static bool deskAct(uint8_t act) {
  switch (act) {
    case ACT_TYPING:
    case ACT_WRITING:
    case ACT_REVIEWING:
    case ACT_PRESENTING:
    case ACT_TALKING:
    case ACT_THINKING:
    case ACT_BLOCKED:
    case ACT_NAP:
    case ACT_OFFLINE: return true;
    default: return false;
  }
}

// Walks toward (tx, ty) (Q8) at speed px/s. Returns true once there.
static bool moveTo(AgentAnim& an, int32_t tx, int32_t ty, int speed, uint32_t dt) {
  int32_t dx = tx - an.x, dy = ty - an.y;
  int32_t dist = (int32_t)ui::isqrt((uint32_t)((dx >> 4) * (dx >> 4) + (dy >> 4) * (dy >> 4))) << 4;
  int32_t step = speed * 256 * (int32_t)dt / 1000;
  if (dist > step && dist > 0) {
    an.x += dx * step / dist;
    an.y += dy * step / dist;
    an.walking = true;
    if (abs(dx) > 64) an.faceLeft = dx < 0;
    return false;
  }
  an.x = tx;
  an.y = ty;
  an.walking = false;
  return true;
}

void app_update() {
  const Model& m = app.model;
  uint32_t dt = app.dt > 100 ? 100 : app.dt;
  int s = app.charScale ? app.charScale : 2;
  // Agents waiting for you line up along the front glass (bottom of the room).
  int nGlass = 0;
  for (int i = 0; i < m.nAgents; i++)
    if (resolveAct(m.agents[i], app.anim[i]) == ACT_WAITING) nGlass++;
  int glassK = 0;
  for (int i = 0; i < m.nAgents; i++) {
    const Agent& a = m.agents[i];
    AgentAnim& an = app.anim[i];
    uint8_t act = resolveAct(a, an);
    if (act != an.act) {
      an.act = act;
      an.actSince = app.now;
    }
    an.mood = resolveMood(a, an, act);
    bool wasGlass = an.atGlass;
    an.atGlass = false;
    an.seated = false;
    if (deskAct(act)) {
      an.seated = moveTo(an, an.deskX << 8, (an.deskY + 3 * s) << 8, 50, dt);
    } else if (act == ACT_WAITING) {
      int spread = nGlass > 1 ? 38 : 0;
      int gx = ui::CX + (glassK * 2 - (nGlass - 1)) * spread / 2;
      glassK++;
      bool there = moveTo(an, gx << 8, 202 << 8, 48, dt);
      an.atGlass = there;
      if (there && !wasGlass) an.glassSince = app.now;
      if (there) an.faceLeft = false;
    } else if (act == ACT_IDLE) {
      if ((int32_t)(app.now - an.nextWander) >= 0) {
        // Pick a new spot on the floor, or take a breather.
        if (ui::rndRange(0, 4) == 0) {
          an.tx = an.x;
          an.ty = an.y;
        } else {
          int r = ui::rndRange(40, 96);
          int ang = ui::rndRange(0, 1024);
          int px, py;
          ui::polar(r, ang, px, py);
          an.tx = px << 8;
          an.ty = py << 8;
        }
        an.nextWander = app.now + ui::rndRange(2500, 6500);
      }
      moveTo(an, an.tx, an.ty, 20, dt);
    } else {
      // Celebrate, coffee, stretch: stay put.
      an.walking = false;
      an.tx = an.x;
      an.ty = an.y;
    }
  }
  // Gentle bumping between wanderers.
  for (int i = 0; i < m.nAgents; i++) {
    if (app.anim[i].act != ACT_IDLE) continue;
    for (int j = i + 1; j < m.nAgents; j++) {
      if (app.anim[j].act != ACT_IDLE) continue;
      AgentAnim &a = app.anim[i], &b = app.anim[j];
      int32_t dx = (a.x - b.x) >> 8, dy = (a.y - b.y) >> 8;
      int d2 = dx * dx + dy * dy;
      int minD = 9 * s;
      if (d2 < minD * minD) {
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
  moments_update();
}

bool app_knockHit(int i) {
  // Knock rhythm at the glass: three raps every 1.6 s.
  const AgentAnim& an = app.anim[i];
  if (!an.atGlass || !active(an.knockUntil)) return false;
  uint32_t t = (app.now - an.glassSince) % 1600;
  return t < 110 || (t >= 280 && t < 390) || (t >= 560 && t < 670);
}

Pose app_pose(int i) {
  const AgentAnim& an = app.anim[i];
  Pose p;
  memset(&p, 0, sizeof(p));
  p.expr = an.mood;
  p.flip = an.faceLeft;
  p.ghost = an.act == ACT_OFFLINE;
  p.legs = an.seated ? LEGS_SEATED : (an.walking ? LEGS_WALK : LEGS_STAND);
  p.arms = ARMS_DOWN;
  uint32_t seed = an.idHash & 0xFFF;
  p.frame = an.walking ? (uint8_t)((app.now / 130) & 3) : (uint8_t)(((app.now + seed) / 900) & 1);
  if (an.walking) return p;
  switch (an.act) {
    case ACT_TYPING:
      p.arms = ARMS_TYPE;
      p.frame = (uint8_t)(((app.now + seed) / 110) & 1);
      break;
    case ACT_WRITING:
      p.arms = ARMS_TYPE;
      p.frame = (uint8_t)(((app.now + seed) / 420) & 1);
      break;
    case ACT_REVIEWING:
    case ACT_THINKING:
    case ACT_COFFEE: p.arms = ARMS_HOLD; break;
    case ACT_PRESENTING:
      p.arms = ARMS_POINT;
      p.flip = false;
      break;
    case ACT_WAITING:
      p.flip = false;
      if (active(an.knockUntil) && an.atGlass) {
        p.arms = ARMS_KNOCK;
        p.frame = app_knockHit(i) ? 1 : 0;
      }
      break;
    case ACT_CELEBRATE:
      p.arms = ARMS_UP;
      p.frame = (uint8_t)((app.now / 180) & 1);
      break;
    case ACT_STRETCH:
      p.arms = ARMS_UP;
      p.frame = (uint8_t)((app.now / 700) & 1);
      break;
    default: break;
  }
  if (active(an.throwUntil)) p.arms = ARMS_THROW;
  return p;
}

// ---------------------------------------------------------------- labels

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

const char* actVerb(uint8_t act) {
  switch (act) {
    case ACT_TYPING: return "typing";
    case ACT_WRITING: return "writing";
    case ACT_REVIEWING: return "reviewing";
    case ACT_PRESENTING: return "presenting";
    case ACT_TALKING: return "talking";
    case ACT_THINKING: return "thinking";
    case ACT_WAITING: return "waiting for you";
    case ACT_BLOCKED: return "blocked";
    case ACT_CELEBRATE: return "celebrating";
    case ACT_COFFEE: return "on a coffee break";
    case ACT_NAP: return "napping";
    case ACT_STRETCH: return "stretching";
    case ACT_OFFLINE: return "offline";
    default: return "wandering";
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

// ---------------------------------------------------------------- camera-safe

static const char* UI_NS = "throne-ui";

void app_loadPrefs() {
  app.camSafePref = CAMSAFE_AUTO;
  Preferences p;
  // Read-write: a read-only begin() on a namespace that does not exist yet logs an error.
  if (!p.begin(UI_NS, false)) return;
  // isKey() first: reading a missing key makes the core log an error.
  if (p.isKey("camsafe")) app.camSafePref = p.getUChar("camsafe", CAMSAFE_AUTO);
  p.end();
}

bool app_camSafe() {
  if (app.camSafePref == CAMSAFE_AUTO) return app.mode == MODE_DIRECTOR;
  return app.camSafePref == CAMSAFE_ON;
}

void app_toggleCamSafe() { app_setCamSafe(!app_camSafe()); }

void app_setCamSafe(bool on) {
  app.camSafePref = on ? CAMSAFE_ON : CAMSAFE_OFF;
  app.camSafeToastMs = app.now;
  Preferences p;
  if (p.begin(UI_NS, false)) {
    p.putUChar("camsafe", app.camSafePref);
    p.end();
  }
  Serial.printf("[ui] camera-safe %s\n", app.camSafePref == CAMSAFE_ON ? "on" : "off");
}

void app_initials(const char* name, char* out, size_t cap) {
  size_t o = 0;
  bool start = true;
  int n = 0;
  for (const char* p = name; *p && n < 3; p++) {
    if (*p == ' ' || *p == '-' || *p == '_' || *p == '.') {
      start = true;
      continue;
    }
    if (start && isalnum((unsigned char)*p) && o + 3 <= cap) {
      out[o++] = (char)toupper((unsigned char)*p);
      out[o++] = '.';
      n++;
    }
    start = false;
  }
  if (!o && cap > 1) out[o++] = '?';
  out[o] = 0;
}

void app_label(const Agent& a, char* out, size_t cap, bool shortName) {
  if (app_camSafe()) app_initials(a.name, out, cap);
  else strlcpy(out, shortName ? a.shortName : a.name, cap);
}
