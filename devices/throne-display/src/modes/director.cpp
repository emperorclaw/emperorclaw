// DIRECTOR: an automatic camera over the Throne Room, made for filming. It cycles a
// shot list (wide room -> eased push-in on the busiest agent -> its thought typing
// out -> pull back) and cuts to every moment as it happens (handoff, task done, needs
// you, blocked). The scene is drawn at 1x by throne_draw(), then the whole frame is
// zoomed in place; text overlays are drawn afterwards at native resolution so they
// stay sharp. Camera-safe is on here by default (see app_camSafe()).
#include "../app.h"
#include "../moments.h"
#include "../palette.h"
#include "../ui_common.h"

using namespace ui;
using pal::c;

namespace {

enum Shot : uint8_t { SHOT_WIDE = 0, SHOT_PUSH, SHOT_HOLD, SHOT_PULL, SHOT_EVENT };

constexpr int Z_WIDE = 256, Z_CLOSE = 512;
constexpr uint32_t WIDE_MS = 3600, PUSH_MS = 1300, PULL_MS = 1100, EVENT_EASE_MS = 700, HOLD_EMPTY_MS = 3500;

uint8_t s_shot = SHOT_WIDE;
uint32_t s_shotStart = 0, s_shotDur = 0;
int s_fromX = CX, s_fromY = CY, s_fromZ = Z_WIDE;
int s_camX = CX, s_camY = CY, s_camZ = Z_WIDE;
uint32_t s_targetHash = 0, s_lastTargetHash = 0;
uint32_t s_lastSerial = 0;
uint32_t s_lastDrawMs = 0;
Moment s_event;
Bubble s_bubble;

void startShot(uint8_t shot, uint32_t dur) {
  s_shot = shot;
  s_shotStart = app.now;
  s_shotDur = dur;
  s_fromX = s_camX;
  s_fromY = s_camY;
  s_fromZ = s_camZ;
}

// Keeps the zoomed view mostly inside the round room.
void clampCam(int& x, int& y, int z) {
  int rmax = 124 - 120 * 256 / z;
  if (rmax < 0) rmax = 0;
  int dx = x - CX, dy = y - CY;
  int d2 = dx * dx + dy * dy;
  if (d2 > rmax * rmax) {
    int d = (int)isqrt((uint32_t)d2);
    x = CX + dx * rmax / d;
    y = CY + dy * rmax / d;
  }
}

bool agentFocus(uint32_t hash, int& x, int& y) {
  int i = app_agentByHash(hash);
  if (i < 0) return false;
  int footY, s;
  actor_anchor(i, x, footY, s);
  y = footY - 11 * s;
  return true;
}

int pickTarget() {
  const Model& m = app.model;
  int best = -1, bestScore = -100;
  for (int i = 0; i < m.nAgents; i++) {
    int score;
    switch (app.anim[i].act) {
      case ACT_PRESENTING:
      case ACT_CELEBRATE: score = 6; break;
      case ACT_TYPING:
      case ACT_WRITING:
      case ACT_REVIEWING: score = 5; break;
      case ACT_TALKING:
      case ACT_THINKING: score = 4; break;
      case ACT_BLOCKED:
      case ACT_WAITING: score = 3; break;
      case ACT_COFFEE:
      case ACT_NAP:
      case ACT_STRETCH: score = 2; break;
      case ACT_OFFLINE: score = -5; break;
      default: score = 1; break;
    }
    if (model_thought(m, m.agents[i])) score += 6;
    if (m.agents[i].idHash == s_lastTargetHash) score -= 9;  // rotate between agents
    score = score * 4 + rndRange(0, 4);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

// Camera target for a moment: who is involved, and how close.
void eventFraming(int& x, int& y, int& z) {
  int ax, ay, bx, by;
  bool a = s_event.aHash && agentFocus(s_event.aHash, ax, ay);
  if (!a) {
    // No agent (the Emperor knocks for an approval): frame the throne.
    x = CX;
    y = CY - 8;
    z = s_event.type == EV_NEEDS_YOU ? 420 : Z_WIDE;
    return;
  }
  switch (s_event.type) {
    case EV_HANDOFF:
      if (agentFocus(s_event.bHash, bx, by)) {
        x = (ax + bx) / 2;
        y = (ay + by) / 2 - 14;
        int d = abs(ax - bx) + abs(ay - by);
        z = d > 0 ? 256 * 150 / d : Z_CLOSE;
        if (z < Z_WIDE) z = Z_WIDE;
        if (z > 420) z = 420;
        return;
      }
      z = 400;
      break;
    case EV_TASK_DONE: z = 470; break;
    case EV_NEEDS_YOU: z = 400; break;
    default: z = 480; break;
  }
  x = ax;
  y = ay;
}

void toScreen(int wx, int wy, int& sx, int& sy) {
  sx = CX + (wx - s_camX) * s_camZ / 256;
  sy = CY + (wy - s_camY) * s_camZ / 256;
}

void drawCaption(const char* line) {
  int w = textWidth(line, F_SMALL) + 20;
  if (w > 190) w = 190;
  fillRoundRect(CX - w / 2, 192, w, 18, 9, c(pal::NEUTRAL, 1));
  textFit(line, CX, 201, w - 14, pal::WHITE, F_SMALL);
}

}  // namespace

void director_enter() {
  s_camX = CX;
  s_camY = CY;
  s_camZ = Z_WIDE;
  s_bubble.on = false;
  s_targetHash = 0;
  const Moment* mo = moments_current();
  s_lastSerial = mo ? mo->serial : s_lastSerial;  // do not replay what already started
  startShot(SHOT_WIDE, WIDE_MS);
}

void director_draw() {
  const Model& m = app.model;
  if (!s_lastDrawMs || app.now - s_lastDrawMs > 500) director_enter();
  s_lastDrawMs = app.now;

  // Events interrupt the shot list.
  const Moment* mo = moments_current();
  if (mo && mo->serial != s_lastSerial) {
    s_lastSerial = mo->serial;
    s_event = *mo;
    s_bubble.on = false;
    startShot(SHOT_EVENT, mo->dur < 2600 ? 2600 : mo->dur);
  }

  uint32_t t = app.now - s_shotStart;
  int toX = CX, toY = CY, toZ = Z_WIDE;
  uint32_t ease = s_shotDur;
  switch (s_shot) {
    case SHOT_WIDE:
      toZ = Z_WIDE + 22;  // a slow push keeps the wide shot alive
      ease = WIDE_MS;
      if (t >= s_shotDur) {
        int i = pickTarget();
        if (i >= 0 && m.nAgents > 0) {
          s_targetHash = m.agents[i].idHash;
          s_lastTargetHash = s_targetHash;
          startShot(SHOT_PUSH, PUSH_MS);
        } else {
          startShot(SHOT_WIDE, WIDE_MS);
        }
        t = 0;
      }
      break;
    case SHOT_PUSH:
    case SHOT_HOLD: {
      if (!agentFocus(s_targetHash, toX, toY)) {
        startShot(SHOT_PULL, PULL_MS);
        break;
      }
      toY -= 10;  // leave head room for the bubble
      toZ = Z_CLOSE;
      if (s_shot == SHOT_PUSH) {
        ease = PUSH_MS;
        if (t >= s_shotDur) {
          int i = app_agentByHash(s_targetHash);
          const Thought* th = i >= 0 ? model_thought(m, m.agents[i]) : nullptr;
          const char* txt = th ? th->text : (i >= 0 ? m.agents[i].activity : "");
          uint32_t dur = HOLD_EMPTY_MS;
          if (txt && *txt) {
            bubble_start(s_bubble, s_targetHash, txt);
            dur = bubble_duration(s_bubble);
            if (dur > 11000) dur = 11000;
          }
          startShot(SHOT_HOLD, dur);
          t = 0;
        }
      } else {
        ease = 400;  // track the agent if it moves
        if (t >= s_shotDur) {
          s_bubble.on = false;
          startShot(SHOT_PULL, PULL_MS);
          t = 0;
        }
      }
      break;
    }
    case SHOT_PULL:
      ease = PULL_MS;
      if (t >= s_shotDur) {
        startShot(SHOT_WIDE, WIDE_MS);
        t = 0;
      }
      break;
    default:  // SHOT_EVENT
      eventFraming(toX, toY, toZ);
      ease = EVENT_EASE_MS;
      if (t >= s_shotDur) {
        startShot(SHOT_PULL, PULL_MS);
        t = 0;
      }
      break;
  }
  clampCam(toX, toY, toZ);
  int k = (int)(t >= ease ? 1024 : t * 1024 / (ease ? ease : 1));
  k = easeInOutCubic(k);
  s_camX = s_fromX + (toX - s_fromX) * k / 1024;
  s_camY = s_fromY + (toY - s_fromY) * k / 1024;
  s_camZ = s_fromZ + (toZ - s_fromZ) * k / 1024;

  throne_draw(true);
  zoomFrame(s_camX + ox, s_camY + oy, s_camZ);

  // ---- native-resolution overlays
  bool safe = app_camSafe();
  char line[64], la[16], lb[16];
  int ti = app_agentByHash(s_shot == SHOT_EVENT ? s_event.aHash : s_targetHash);
  if (s_bubble.on && ti >= 0) {
    int wx, footY, s;
    actor_anchor(ti, wx, footY, s);
    int sx, sy, sfx, sfy;
    toScreen(wx, footY - 18 * s, sx, sy);
    toScreen(wx, footY, sfx, sfy);
    bubble_draw(s_bubble, sx, sy, sfy);
  }
  moments_drawOverlay();
  if (ti >= 0 && (s_shot == SHOT_PUSH || s_shot == SHOT_HOLD || s_shot == SHOT_EVENT)) {
    app_label(m.agents[ti], la, sizeof(la), true);
    if (s_shot == SHOT_EVENT) {
      int bi = app_agentByHash(s_event.bHash);
      switch (s_event.type) {
        case EV_HANDOFF:
          if (bi >= 0) app_label(m.agents[bi], lb, sizeof(lb), true);
          else strlcpy(lb, "team", sizeof(lb));
          snprintf(line, sizeof(line), "%s > %s", la, lb);
          break;
        case EV_TASK_DONE: snprintf(line, sizeof(line), "%s shipped it", la); break;
        case EV_NEEDS_YOU: snprintf(line, sizeof(line), "%s needs you", la); break;
        default: snprintf(line, sizeof(line), "%s is blocked", la); break;
      }
      if (s_event.type == EV_HANDOFF) drawCaption(line);
    } else {
      snprintf(line, sizeof(line), "%s is %s", la, actVerb(app.anim[ti].act));
      drawCaption(line);
    }
  }

  // "LIVE" tag, and the camera-safe badge.
  bool blink = (app.now / 600) & 1;
  fillCircle(CX - 22, 30, 3, c(pal::RED, blink ? 12 : 6));
  text("LIVE", CX - 15, 30, pal::WHITE, F_TINY, lgfx::middle_left);
  if (safe) {
    fillRoundRect(CX + 6, 24, 30, 12, 6, c(pal::GOLD, 4));
    text("SAFE", CX + 21, 30, c(pal::GOLD, 15), F_TINY);
  }
}
