# PV-Display (mksoft)

Fronius-PV-Anzeige auf ESP32-Touchdisplays mit ESPHome, ohne Home Assistant.

## Aufbau

| Datei | Inhalt |
|---|---|
| `common.yaml` | Gemeinsame Logik: Fronius-Abfrage, Netzwerksuche, Einstellungen, Zeit, Auto-Update |
| `fronius_scan.h` | Suche nach dem Wechselrichter im lokalen Netz |
| `board-4848s040.yaml` | Guition ESP32-4848S040 – 4", 480×480 |
| `board-2432s028.yaml` | ESP32-2432S028 („Cheap Yellow Display“) – 2,8", 320×240 |
| `dev-*.yaml` | Entwicklungs-Builds mit Netzwerk-OTA und Debug-Log (nie verteilen) |
| `pv_data.h` | Summen über mehrere Wechselrichter, Watt/kW-Formatierung |
| `web/src/` | Handy-Oberfläche (TypeScript + Tailwind), gebaut nach `web/dist/` |
| `tools/make-manifest.ts` | Erzeugt das Update-Manifest |

Beide Board-Oberflächen verwenden dieselben Widget-IDs (`lbl_pv`, `arc_pv`, `dot_pv` …),
damit `common.yaml` sie befüllen kann. Ein neues Board braucht alle diese IDs.

## Handy-Oberfläche

Im Browser die IP des Displays öffnen (steht in den Einstellungen am Display).
Übersicht und Einstellungen laufen ohne Internet. „Erweitert“ lädt die
ESPHome-Standardansicht nach (braucht Internet am Handy).

Nach Änderungen in `web/src/`:

```bash
npm install
npm run build:web                         # erzeugt web/dist/ – mit einchecken
```

## Lokal bauen und flashen

```bash
cp secrets.yaml.example secrets.yaml      # OTA-Passwort setzen
npm install && npm run build:web
esphome run dev-4848s040.yaml             # oder dev-2432s028.yaml
```

### ESP32-2432S028: Variante und Touch

- In `board-2432s028.yaml` unter `cyd_model` die Display-Variante wählen
  (`ESP32-2432S028`, `-7789` oder `-9342`). Bei falscher Wahl bleibt das Bild weiß
  oder die Farben sind vertauscht.
- `cyd_rotation`: `90` oder `270`, je nachdem, auf welcher Seite die USB-Buchse sein soll.
- Touch kalibrieren: `dev-2432s028.yaml` flashen, die vier Ecken antippen und die
  `raw_x`/`raw_y`-Werte aus dem Log unter `calibration` eintragen.

## Release

```bash
git tag -a v1.2.0 -m "Kurze Beschreibung für die Update-Anzeige"
git push origin v1.2.0
```

Die GitHub Action baut alle Boards und veröffentlicht:

- `https://update.mksoft.at/pv-display/manifest.json` (4848S040)
- `https://update.mksoft.at/pv-display-cyd/manifest.json` (2432S028)
