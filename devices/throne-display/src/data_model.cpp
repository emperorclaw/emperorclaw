#include "data_model.h"

#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

NetInfo g_net = {NET_DEMO, false, 0, 0, 0, 0};

static Model s_shared;
static SemaphoreHandle_t s_mutex = nullptr;
static uint32_t s_seq = 0;

void model_init() {
  s_mutex = xSemaphoreCreateMutex();
  memset(&s_shared, 0, sizeof(s_shared));
}

void model_publish(Model& m) {
  m.seq = ++s_seq;
  m.receivedMs = millis();
  xSemaphoreTake(s_mutex, portMAX_DELAY);
  memcpy(&s_shared, &m, sizeof(Model));
  xSemaphoreGive(s_mutex);
}

bool model_take(Model& dst, uint32_t& lastSeq) {
  if (s_shared.seq == lastSeq) return false;  // benign racy peek; confirmed under the lock
  if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(5)) != pdTRUE) return false;
  bool changed = s_shared.seq != lastSeq;
  if (changed) {
    memcpy(&dst, &s_shared, sizeof(Model));
    lastSeq = dst.seq;
  }
  xSemaphoreGive(s_mutex);
  return changed;
}

uint32_t fnv1a(const char* s) {
  uint32_t h = 2166136261u;
  if (!s) return 0;
  while (*s) {
    h ^= (uint8_t)*s++;
    h *= 16777619u;
  }
  return h ? h : 1;
}

// Latin-1 Supplement U+00C0..U+00FF and Latin Extended-A U+0100..U+017F folded to
// ASCII. A second letter for ligatures (AE, ss, Th) is added in latinFold().
static const char kLatin1[] = "AAAAAAACEEEEIIIIDNOOOOOxOUUUUYTsaaaaaaaceeeeiiiidnooooo/ouuuuyty";
static const char kLatinExtA[] =
    "AaAaAaCcCcCcCcDd"  // U+0100
    "DdEeEeEeEeEeGgGg"  // U+0110
    "GgGgHhHhIiIiIiIi"  // U+0120
    "IiIiJjKkkLlLlLlL"  // U+0130
    "lLlNnNnNnnNnOoOo"  // U+0140
    "OoOoRrRrRrSsSsSs"  // U+0150
    "SsTtTtTtUuUuUuUu"  // U+0160
    "UuUuWwYyYZzZzZzs"; // U+0170

// Returns the ASCII letter for an accented Latin code point (0 if none) and, for
// ligatures, a second letter in *second.
static char latinFold(uint32_t cp, char* second) {
  *second = 0;
  if (cp >= 0xC0 && cp <= 0xFF) {
    switch (cp) {
      case 0xC6: *second = 'E'; break;  // AE
      case 0xE6: *second = 'e'; break;  // ae
      case 0xDE: *second = 'h'; break;  // Th
      case 0xFE: *second = 'h'; break;  // th
      case 0xDF: *second = 's'; break;  // ss
      default: break;
    }
    return kLatin1[cp - 0xC0];
  }
  if (cp >= 0x100 && cp <= 0x17F) {
    if (cp == 0x152) *second = 'E';  // OE
    if (cp == 0x153) *second = 'e';  // oe
    return kLatinExtA[cp - 0x100];
  }
  return 0;
}

void asciiCopy(char* dst, size_t cap, const char* src) {
  if (!cap) return;
  size_t o = 0;
  if (!src) src = "";
  const uint8_t* p = (const uint8_t*)src;
  auto put = [&](char c) {
    if (o + 1 < cap) dst[o++] = c;
  };
  bool lastSpace = false;
  while (*p && o + 1 < cap) {
    uint8_t c = *p;
    if (c < 0x80) {
      if (c == '\n' || c == '\r' || c == '\t') c = ' ';
      if (c < 0x20) {
        p++;
        continue;
      }
      if (c == ' ' && lastSpace) {
        p++;
        continue;
      }
      lastSpace = c == ' ';
      put((char)c);
      p++;
      continue;
    }
    // Multi-byte UTF-8 sequence: map a few common punctuation marks, drop the rest.
    uint32_t cp = 0;
    int extra = 0;
    if ((c & 0xE0) == 0xC0) {
      cp = c & 0x1F;
      extra = 1;
    } else if ((c & 0xF0) == 0xE0) {
      cp = c & 0x0F;
      extra = 2;
    } else if ((c & 0xF8) == 0xF0) {
      cp = c & 0x07;
      extra = 3;
    }
    p++;
    for (int i = 0; i < extra && (*p & 0xC0) == 0x80; i++) cp = (cp << 6) | (*p++ & 0x3F);
    switch (cp) {
      case 0x2018: case 0x2019: put('\''); break;
      case 0x201C: case 0x201D: put('"'); break;
      case 0x2013: case 0x2014: put('-'); break;
      case 0x2026: put('.'); put('.'); put('.'); break;
      case 0x00A0: put(' '); break;
      case 0x00A1: put('!'); break;
      case 0x00BF: put('?'); break;
      case 0x00AB: case 0x00BB: put('"'); break;
      default: {
        char second;
        char base = latinFold(cp, &second);
        if (base) {
          put(base);
          if (second) put(second);
        }
        break;  // emoji and other symbols are dropped
      }
    }
    lastSpace = false;
  }
  dst[o] = 0;
}

void model_recount(Model& m) {
  Summary& s = m.s;
  int16_t ip = s.tasksInProgress, ov = s.tasksOverdue, pa = s.pendingApprovals;
  memset(&s, 0, sizeof(s));
  s.tasksInProgress = ip;
  s.tasksOverdue = ov;
  s.pendingApprovals = pa;
  s.agents = m.nAgents;
  for (int i = 0; i < m.nAgents; i++) {
    const Agent& a = m.agents[i];
    switch (a.health) {
      case H_HEALTHY: s.healthy++; break;
      case H_ATTENTION: s.attention++; break;
      case H_DOWN: s.down++; break;
      default: s.idle++; break;
    }
    if (a.state == S_WORKING || a.state == S_TYPING) s.working++;
  }
}
