#pragma once
// ---------------------------------------------------------------------------
// Fronius-Netzwerksuche (Solar API v1)
//
// Sucht im lokalen /24-Netz nach einem Fronius-Wechselrichter:
//   1. Schneller Port-80-Scan mit nicht-blockierenden Sockets (8 parallel)
//   2. Geräte mit offenem Port 80 werden per GET /solar_api/GetAPIVersion.cgi
//      geprüft – nur ein echter Fronius antwortet mit "BaseURL" + "solar_api".
//
// Läuft als eigener FreeRTOS-Task auf Core 0, damit LVGL/Display auf Core 1
// flüssig bleiben. Der ESPHome-Loop fragt nur state()/progress() ab.
// ---------------------------------------------------------------------------

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"

namespace fronius_scan {

enum class State : uint8_t { IDLE, RUNNING, FOUND, NOT_FOUND };

static const char *const TAG = "fronius_scan";
static constexpr size_t BATCH_SIZE = 8;          // parallele Verbindungsversuche
static constexpr int CONNECT_TIMEOUT_MS = 400;   // pro Batch
static constexpr int HTTP_TIMEOUT_MS = 1500;     // pro Kandidat

inline std::atomic<State> g_state{State::IDLE};
inline std::atomic<int> g_progress{0};
inline std::mutex g_mutex;
inline std::string g_result;

inline std::string ip_to_string(uint32_t ip_host_order) {
  char buf[16];
  snprintf(buf, sizeof(buf), "%u.%u.%u.%u",
           static_cast<unsigned>((ip_host_order >> 24) & 0xFF),
           static_cast<unsigned>((ip_host_order >> 16) & 0xFF),
           static_cast<unsigned>((ip_host_order >> 8) & 0xFF),
           static_cast<unsigned>(ip_host_order & 0xFF));
  return buf;
}

// Prüft, ob unter dieser IP die Fronius Solar API antwortet.
inline bool is_fronius(const std::string &ip) {
  const std::string url = "http://" + ip + "/solar_api/GetAPIVersion.cgi";

  esp_http_client_config_t cfg = {};
  cfg.url = url.c_str();
  cfg.timeout_ms = HTTP_TIMEOUT_MS;
  cfg.disable_auto_redirect = true;

  esp_http_client_handle_t client = esp_http_client_init(&cfg);
  if (client == nullptr) return false;

  bool found = false;
  if (esp_http_client_open(client, 0) == ESP_OK) {
    esp_http_client_fetch_headers(client);
    if (esp_http_client_get_status_code(client) == 200) {
      char buf[257];
      const int len = esp_http_client_read(client, buf, sizeof(buf) - 1);
      if (len > 0) {
        buf[len] = '\0';
        found = strstr(buf, "BaseURL") != nullptr && strstr(buf, "solar_api") != nullptr;
      }
    }
  }
  esp_http_client_cleanup(client);
  return found;
}

// Startet für bis zu BATCH_SIZE Hosts gleichzeitig einen TCP-Connect auf Port 80
// und sammelt die Hosts, bei denen der Port offen ist.
inline void probe_batch(const uint32_t *ips, size_t count, std::vector<uint32_t> &open_hosts) {
  int socks[BATCH_SIZE];
  uint32_t targets[BATCH_SIZE];
  bool done[BATCH_SIZE];
  size_t n = 0;

  for (size_t i = 0; i < count && n < BATCH_SIZE; i++) {
    int s = lwip_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s < 0) {
      vTaskDelay(pdMS_TO_TICKS(50));  // kurz warten, Sockets werden freigegeben
      s = lwip_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
      if (s < 0) continue;
    }
    lwip_fcntl(s, F_SETFL, lwip_fcntl(s, F_GETFL, 0) | O_NONBLOCK);

    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(80);
    addr.sin_addr.s_addr = htonl(ips[i]);
    lwip_connect(s, reinterpret_cast<sockaddr *>(&addr), sizeof(addr));

    socks[n] = s;
    targets[n] = ips[i];
    done[n] = false;
    n++;
  }

  const int64_t deadline = esp_timer_get_time() + CONNECT_TIMEOUT_MS * 1000LL;
  size_t pending = n;

  while (pending > 0 && esp_timer_get_time() < deadline) {
    fd_set wfds;
    FD_ZERO(&wfds);
    int maxfd = -1;
    for (size_t i = 0; i < n; i++) {
      if (done[i]) continue;
      FD_SET(socks[i], &wfds);
      maxfd = std::max(maxfd, socks[i]);
    }

    timeval tv = {0, 50 * 1000};
    if (lwip_select(maxfd + 1, nullptr, &wfds, nullptr, &tv) <= 0) continue;

    for (size_t i = 0; i < n; i++) {
      if (done[i] || !FD_ISSET(socks[i], &wfds)) continue;
      int err = 0;
      socklen_t len = sizeof(err);
      lwip_getsockopt(socks[i], SOL_SOCKET, SO_ERROR, &err, &len);
      if (err == 0) open_hosts.push_back(targets[i]);
      done[i] = true;
      pending--;
    }
  }

  for (size_t i = 0; i < n; i++) lwip_close(socks[i]);
}

inline void scan_task(void *) {
  std::string result;

  esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
  esp_netif_ip_info_t info = {};

  if (netif != nullptr && esp_netif_get_ip_info(netif, &info) == ESP_OK && info.ip.addr != 0) {
    const uint32_t own = ntohl(info.ip.addr);
    const uint32_t net = own & 0xFFFFFF00u;  // es wird immer das eigene /24 durchsucht

    std::vector<uint32_t> hosts;
    hosts.reserve(254);
    for (uint32_t h = 1; h < 255; h++) {
      if ((net | h) != own) hosts.push_back(net | h);
    }

    ESP_LOGI(TAG, "Suche in %s/24 ...", ip_to_string(net).c_str());

    // Phase 1: Port-Scan (0–80 % Fortschritt)
    std::vector<uint32_t> open_hosts;
    for (size_t i = 0; i < hosts.size(); i += BATCH_SIZE) {
      const size_t end = std::min(i + BATCH_SIZE, hosts.size());
      probe_batch(hosts.data() + i, end - i, open_hosts);
      g_progress = static_cast<int>(end * 80 / hosts.size());
    }
    ESP_LOGI(TAG, "%u Geräte mit offenem Port 80", static_cast<unsigned>(open_hosts.size()));

    // Phase 2: Solar-API-Prüfung (80–100 % Fortschritt)
    for (size_t i = 0; i < open_hosts.size() && result.empty(); i++) {
      const std::string ip = ip_to_string(open_hosts[i]);
      if (is_fronius(ip)) {
        result = ip;
        ESP_LOGI(TAG, "Fronius gefunden: %s", ip.c_str());
      }
      g_progress = 80 + static_cast<int>((i + 1) * 20 / open_hosts.size());
    }
  } else {
    ESP_LOGW(TAG, "Keine IP-Adresse – WLAN nicht verbunden?");
  }

  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_result = result;
  }
  g_progress = 100;
  g_state = result.empty() ? State::NOT_FOUND : State::FOUND;
  vTaskDelete(nullptr);
}

// ---------------------------------------------------------------------------
// Öffentliche Funktionen für die YAML-Lambdas
// ---------------------------------------------------------------------------

inline bool start() {
  if (g_state == State::RUNNING) return false;
  g_progress = 0;
  g_state = State::RUNNING;
  if (xTaskCreatePinnedToCore(scan_task, "fronius_scan", 8192, nullptr, 2, nullptr, 0) != pdPASS) {
    g_state = State::NOT_FOUND;
    return false;
  }
  return true;
}

inline State state() { return g_state.load(); }
inline int progress() { return g_progress.load(); }
inline bool is_running() { return g_state == State::RUNNING; }

// Liefert die gefundene IP und setzt den Status zurück auf IDLE.
inline std::string take_result() {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_state = State::IDLE;
  return g_result;
}

}  // namespace fronius_scan
