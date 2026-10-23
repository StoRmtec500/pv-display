#pragma once
// ---------------------------------------------------------------------------
// Mehrere Fronius-Wechselrichter zusammenfassen + Leistungsformatierung
//
// Jeder Wechselrichter liefert über seine eigene Solar API Daten in einen
// "Slot". totals() summiert alle aktuellen Slots:
//   PV, Akku, Tagesertrag  -> Summe
//   Netz                   -> erster Wert eines Wechselrichters mit Smart Meter
//                             (es gibt nur einen Netzanschlusspunkt)
//   Hausverbrauch          -> selbst gerechnet: Netz + PV + Akku
//                             (Fronius' eigener P_Load kennt nur die eigene PV)
//   Autarkie               -> aus Verbrauch und Netzbezug gerechnet
//   Ladestand              -> Mittelwert aller Akkus
// ---------------------------------------------------------------------------

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "esphome/components/json/json_util.h"
#include "esphome/core/hal.h"

namespace pv {

static constexpr int MAX_INVERTERS = 3;
static constexpr uint32_t MAX_AGE_MS = 20000;     // ältere Werte zählen nicht mehr
static constexpr uint8_t BACKOFF_AFTER = 3;       // Fehlversuche bis zur Drosselung
static constexpr uint32_t BACKOFF_MS = 30000;     // dann nur noch alle 30 s versuchen

struct Slot {
  float pv = NAN;
  float grid = NAN;     // > 0 Bezug, < 0 Einspeisung (nur mit Smart Meter)
  float akku = NAN;     // > 0 entlädt, < 0 lädt
  float eday = NAN;     // Wh
  float soc = NAN;      // %
  uint32_t last_ok = 0;
  uint32_t last_try = 0;
  uint8_t fails = 0;
};

struct Totals {
  bool valid = false;
  bool has_grid = false;
  bool has_akku = false;
  float pv = 0, grid = 0, akku = 0, load = 0, autarky = NAN, eday_kwh = NAN, soc = NAN;
};

inline Slot slots[MAX_INVERTERS];

inline bool is_fresh(const Slot &s, uint32_t now) { return s.last_ok != 0 && now - s.last_ok < MAX_AGE_MS; }

// Gedrosselt: ein dauerhaft nicht erreichbarer Wechselrichter blockiert die
// Anzeige sonst bei jeder Abfrage für die volle Timeout-Dauer.
inline bool should_poll(int i, uint32_t now) {
  const Slot &s = slots[i];
  return s.fails < BACKOFF_AFTER || now - s.last_try >= BACKOFF_MS;
}

inline void mark_try(int i, uint32_t now) { slots[i].last_try = now; }

inline void mark_fail(int i) {
  if (slots[i].fails < 255) slots[i].fails++;
}

inline void clear(int i) { slots[i] = Slot{}; }

// Wird bei jeder Änderung eines IP-Felds aufgerufen. Nur eine echte Änderung
// löscht die alten Werte – sonst würde die Summe kurz einbrechen.
inline std::string known_ips[MAX_INVERTERS];
inline void on_ip_changed(int i, const std::string &ip) {
  if (i < 0 || i >= MAX_INVERTERS || known_ips[i] == ip) return;
  known_ips[i] = ip;
  clear(i);
}

static inline float opt(JsonVariantConst v) { return v.isNull() ? NAN : v.as<float>(); }

// Wertet GetPowerFlowRealtimeData.fcgi aus und speichert in Slot i.
inline bool parse(int i, const std::string &body, uint32_t now) {
  Slot parsed;
  bool ok = esphome::json::parse_json(body, [&parsed](JsonObject root) -> bool {
    JsonObjectConst site = root["Body"]["Data"]["Site"];
    if (site.isNull()) return false;
    parsed.pv = site["P_PV"].isNull() ? 0.0f : site["P_PV"].as<float>();  // nachts null
    parsed.grid = opt(site["P_Grid"]);
    parsed.akku = opt(site["P_Akku"]);
    parsed.eday = opt(site["E_Day"]);
    JsonObjectConst inverters = root["Body"]["Data"]["Inverters"];
    for (JsonPairConst kv : inverters) {
      JsonVariantConst s = kv.value()["SOC"];
      if (!s.isNull()) {
        parsed.soc = s.as<float>();
        break;
      }
    }
    return true;
  });
  if (!ok) return false;
  parsed.last_ok = now;
  parsed.last_try = slots[i].last_try;
  parsed.fails = 0;
  slots[i] = parsed;
  return true;
}

inline Totals totals(uint32_t now) {
  Totals t;
  float soc_sum = 0, eday_sum = 0;
  int soc_n = 0, eday_n = 0;
  for (const Slot &s : slots) {
    if (!is_fresh(s, now)) continue;
    t.valid = true;
    t.pv += s.pv;
    if (!std::isnan(s.akku)) {
      t.akku += s.akku;
      t.has_akku = true;
    }
    if (!std::isnan(s.grid) && !t.has_grid) {
      t.grid = s.grid;
      t.has_grid = true;
    }
    if (!std::isnan(s.soc)) {
      soc_sum += s.soc;
      soc_n++;
    }
    if (!std::isnan(s.eday)) {
      eday_sum += s.eday;
      eday_n++;
    }
  }
  if (!t.valid) return t;
  t.load = std::max(0.0f, t.grid + t.pv + t.akku);
  if (t.has_grid && t.load > 1.0f) {
    t.autarky = std::min(100.0f, std::max(0.0f, (t.load - std::max(0.0f, t.grid)) / t.load * 100.0f));
  }
  if (soc_n > 0) t.soc = soc_sum / soc_n;
  if (eday_n > 0) t.eday_kwh = eday_sum / 1000.0f;
  return t;
}

// ---------------------------------------------------------------------------
// Formatierung: unter 1 kW in Watt, darüber in kW
// ---------------------------------------------------------------------------

inline bool use_watts(float w) { return std::fabs(w) < 999.5f; }

// Nur die Zahl (für große Anzeigen mit eigenem Einheiten-Label)
inline std::string power_value(float w) {
  char buf[16];
  w = std::fabs(w);
  // ab 10 kW eine, ab 100 kW keine Nachkommastelle – passt in den Ring
  if (use_watts(w)) snprintf(buf, sizeof(buf), "%.0f", w);
  else if (w < 9995.0f) snprintf(buf, sizeof(buf), "%.2f", w / 1000.0f);
  else if (w < 99950.0f) snprintf(buf, sizeof(buf), "%.1f", w / 1000.0f);
  else snprintf(buf, sizeof(buf), "%.0f", w / 1000.0f);
  return buf;
}

inline const char *power_unit(float w) { return use_watts(w) ? "W" : "kW"; }

// Zahl + Einheit, z. B. "800 W" oder "1.35 kW"
inline std::string power_text(float w) { return power_value(w) + " " + power_unit(w); }

// "192.168.1.50, .51, .52" – gemeinsamer Netzanteil wird nur einmal angezeigt
inline std::string ip_list(const std::vector<std::string> &ips) {
  std::string out;
  std::string first_prefix;
  for (const std::string &ip : ips) {
    if (ip.empty()) continue;
    const size_t dot = ip.rfind('.');
    const std::string prefix = dot == std::string::npos ? "" : ip.substr(0, dot);
    if (out.empty()) {
      out = ip;
      first_prefix = prefix;
    } else if (!prefix.empty() && prefix == first_prefix) {
      out += ", " + ip.substr(dot);
    } else {
      out += ", " + ip;
    }
  }
  return out.empty() ? "nicht gesetzt" : out;
}

}  // namespace pv

// true, wenn Version a neuer ist als b ("1.10.0" > "1.9.3"; Zusatz wie "-beta.1" ist älter
// als die gleiche Version ohne Zusatz). Verhindert, dass ältere Versionen als Update gelten.
inline bool version_newer(const std::string &a, const std::string &b) {
  auto parse = [](const std::string &v, int out[3], std::string &pre) {
    out[0] = out[1] = out[2] = 0;
    size_t i = 0;
    for (int part = 0; part < 3 && i < v.size(); part++) {
      int n = 0;
      while (i < v.size() && v[i] >= '0' && v[i] <= '9') n = n * 10 + (v[i++] - '0');
      out[part] = n;
      if (i < v.size() && v[i] == '.') i++;
    }
    pre = i < v.size() && v[i] == '-' ? v.substr(i + 1) : std::string();
  };
  int va[3], vb[3];
  std::string pa, pb;
  parse(a, va, pa);
  parse(b, vb, pb);
  for (int k = 0; k < 3; k++)
    if (va[k] != vb[k]) return va[k] > vb[k];
  if (pa.empty() != pb.empty()) return pa.empty();   // 1.5.0 > 1.5.0-beta
  return pa > pb;
}

// Release-Beschreibung (mehrzeilig, "- "-Liste) für das Update-Popup aufbereiten:
// höchstens max_lines Zeilen, jede höchstens max_chars Zeichen (UTF-8-sicher gekürzt),
// "- " am Zeilenanfang wird zu "· " (Glyphe ist in allen Display-Schriften enthalten).
inline std::vector<std::string> upd_summary_lines(const std::string &summary, size_t max_lines, size_t max_chars) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= summary.size() && out.size() < max_lines) {
    size_t end = summary.find('\n', start);
    if (end == std::string::npos) end = summary.size();
    std::string line = summary.substr(start, end - start);
    start = end + 1;
    while (!line.empty() && (line.back() == ' ' || line.back() == '\r')) line.pop_back();
    if (line.empty()) continue;
    if (line.rfind("- ", 0) == 0) line = "\xC2\xB7 " + line.substr(2);

    // Zeichen (nicht Bytes) zählen und ggf. kürzen
    size_t chars = 0, cut = std::string::npos;
    for (size_t i = 0; i < line.size(); i++) {
      if ((line[i] & 0xC0) == 0x80) continue;   // Folgebyte eines UTF-8-Zeichens
      if (chars == max_chars - 3) cut = i;
      chars++;
    }
    if (chars > max_chars && cut != std::string::npos) line = line.substr(0, cut) + "...";
    out.push_back(line);
  }
  // Mehr Zeilen vorhanden als Platz: letzte Zeile als Hinweis ersetzen
  if (out.size() == max_lines && start < summary.size()) out.back() = "\xC2\xB7 ...";
  return out;
}
