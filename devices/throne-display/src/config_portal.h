// Persistent configuration (NVS via Preferences) and the captive setup portal.
// Secrets are never printed to Serial and never echoed back into the portal page.
#pragma once
#include <Arduino.h>

struct Config {
  char ssid[33];
  char pass[65];
  char server[128];  // base URL, e.g. https://emperor.example.com (http:// allowed for LAN dev)
  char token[200];   // read_only company API token
  bool demo;         // force demo mode even when configured
};

extern Config g_cfg;

void config_load();
void config_save();
void config_clear();
// True when Wi-Fi + server + token are all present.
bool config_complete();

// https:// is always allowed (the certificate is verified). Plain http:// is only
// allowed for private-network hosts (10.x, 172.16-31.x, 192.168.x, *.local), so the
// Bearer token never crosses the internet unencrypted.
bool server_isAllowed(const char* url);

// Two server URLs are the same target (case-insensitive, trailing slashes ignored).
bool server_same(const char* a, const char* b);

constexpr const char* PORTAL_AP_NAME = "EmperorClaw-Display";
constexpr uint32_t PORTAL_TIMEOUT_MS = 10UL * 60UL * 1000UL;

void portal_begin();  // blocking setup is avoided: call portal_loop() every frame
void portal_loop();
bool portal_active();
uint32_t portal_startedMs();
// WPA2 password of the setup network: 8 random digits, new every time the portal
// opens, shown only on the display (never on serial).
const char* portal_password();
