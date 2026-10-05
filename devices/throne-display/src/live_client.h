// Background producer task: either runs the demo simulation or polls
// GET {server}/api/mcp/live?messages=8 with a Bearer token and ETag caching.
// Runs on its own FreeRTOS task so the render loop never waits on the network.
#pragma once
#include <Arduino.h>

void net_begin(bool demo);
void net_setDemo(bool demo);
bool net_demo();
void net_pause(bool paused);  // used while the setup portal owns the radio
// Forces an immediate fetch (live mode) on the next task iteration.
void net_kick();

// Wi-Fi power: transmit bursts at the default ~20 dBm can pull enough current to
// brown out the USB-Serial/JTAG link on this board (the screen keeps running but
// the host loses the COM port). Every place that turns the radio on calls this.
#ifndef WIFI_TX_POWER
#define WIFI_TX_POWER WIFI_POWER_15dBm
#endif
// Wi-Fi starts this long after boot so USB enumeration and the display init finish first.
constexpr uint32_t WIFI_START_DELAY_MS = 3000;
void wifi_applyTxPower();
// g_net.lastHttp value when the configured server is plain http:// on a public host.
constexpr int16_t HTTP_INSECURE_SERVER = -300;
