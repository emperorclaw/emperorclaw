// LovyanGFX device definition for the ESP32-2424S012C-I round display board.
// Panel: GC9A01 240x240 IPS over SPI. Backlight on GPIO3 (PWM).
// Pin map verified against https://www.espboards.dev/esp32/cyd-esp32-2424s012/
#pragma once

#define LGFX_USE_V1
#include <LovyanGFX.hpp>

namespace pins {
constexpr int LCD_SCLK = 6;
constexpr int LCD_MOSI = 7;
constexpr int LCD_CS = 10;
constexpr int LCD_DC = 2;
constexpr int LCD_RST = -1;  // tied to EN
constexpr int LCD_BL = 3;
constexpr int TOUCH_SDA = 4;
constexpr int TOUCH_SCL = 5;
constexpr int TOUCH_INT = 0;
constexpr int TOUCH_RST = 1;
constexpr uint8_t TOUCH_ADDR = 0x15;
}  // namespace pins

class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_GC9A01 _panel;
  lgfx::Bus_SPI _bus;
  lgfx::Light_PWM _light;

 public:
  LGFX() {
    {
      auto cfg = _bus.config();
      cfg.spi_host = SPI2_HOST;
      cfg.spi_mode = 0;
      cfg.freq_write = 80000000;
      cfg.freq_read = 20000000;
      cfg.spi_3wire = true;
      cfg.use_lock = true;
      cfg.dma_channel = SPI_DMA_CH_AUTO;
      cfg.pin_sclk = pins::LCD_SCLK;
      cfg.pin_mosi = pins::LCD_MOSI;
      cfg.pin_miso = -1;
      cfg.pin_dc = pins::LCD_DC;
      _bus.config(cfg);
      _panel.setBus(&_bus);
    }
    {
      auto cfg = _panel.config();
      cfg.pin_cs = pins::LCD_CS;
      cfg.pin_rst = pins::LCD_RST;
      cfg.pin_busy = -1;
      cfg.panel_width = 240;
      cfg.panel_height = 240;
      cfg.offset_x = 0;
      cfg.offset_y = 0;
      cfg.offset_rotation = 0;
      cfg.dummy_read_pixel = 8;
      cfg.dummy_read_bits = 1;
      cfg.readable = false;
      cfg.invert = true;
      cfg.rgb_order = false;
      cfg.dlen_16bit = false;
      cfg.bus_shared = false;
      _panel.config(cfg);
    }
    {
      auto cfg = _light.config();
      cfg.pin_bl = pins::LCD_BL;
      cfg.invert = false;
      cfg.freq = 12000;
      cfg.pwm_channel = 0;
      _light.config(cfg);
      _panel.setLight(&_light);
    }
    setPanel(&_panel);
  }
};
