/**
 * PV-Display – Handy-Oberfläche
 *
 * Wird vom ESPHome-Webserver als /0.js ausgeliefert (js_include) und ersetzt
 * die Standardseite. Live-Werte kommen per Server-Sent Events über /events,
 * Änderungen gehen per POST an die ESPHome-REST-API (/<domain>/<Name>/<aktion>).
 *
 * Bauen:  npm run build:web   →  web/dist/dashboard.js + dashboard.css
 */

// ---------------------------------------------------------------------------
// Entitäten (Namen wie in common.yaml – dienen als ID im Webserver)
// ---------------------------------------------------------------------------

const E = {
  pv: 'sensor/PV Leistung',
  grid: 'sensor/Netz',
  load: 'sensor/Verbrauch',
  akku: 'sensor/Akku Leistung',
  soc: 'sensor/Akku Ladestand',
  autarky: 'sensor/Autarkie',
  eday: 'sensor/Ertrag heute',
  online: 'binary_sensor/Fronius erreichbar',
  ip1: 'text/Fronius IP',
  ip2: 'text/Fronius IP 2',
  ip3: 'text/Fronius IP 3',
  brightness: 'number/Helligkeit',
  peak: 'number/Anlagenleistung',
  autoUpdate: 'switch/Automatische Updates',
  scan: 'button/Wechselrichter suchen',
  restart: 'button/Neustart',
  checkUpdate: 'button/Nach Updates suchen',
  firmware: 'update/Firmware',
  scanStatus: 'text_sensor/Suchstatus',
} as const;

type EntityId = (typeof E)[keyof typeof E];
const IP_IDS = [E.ip1, E.ip2, E.ip3] as const;

interface EntityState {
  id: string;
  value?: unknown;
  state?: string;
  current_version?: string;
  latest_version?: string;
  summary?: string;
}

const store = new Map<string, EntityState>();

function num(id: EntityId): number | null {
  const v = store.get(id)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(id: EntityId): string {
  const s = store.get(id);
  if (!s) return '';
  return typeof s.value === 'string' ? s.value : (s.state ?? '');
}

function bool(id: EntityId): boolean {
  return store.get(id)?.value === true;
}

// ---------------------------------------------------------------------------
// Formatierung (gleiche Regel wie am Display: unter 1 kW in Watt)
// ---------------------------------------------------------------------------

interface Power {
  value: string;
  unit: 'W' | 'kW';
}

function power(w: number | null): Power {
  if (w === null) return { value: '--', unit: 'kW' };
  const a = Math.abs(w);
  return a < 999.5 ? { value: a.toFixed(0), unit: 'W' } : { value: (a / 1000).toFixed(2), unit: 'kW' };
}

function powerText(w: number | null): string {
  const p = power(w);
  return `${p.value} ${p.unit}`;
}

// ---------------------------------------------------------------------------
// Verbindung zum Gerät
// ---------------------------------------------------------------------------

type ConnState = 'connecting' | 'live' | 'offline';
let conn: ConnState = 'connecting';

function connect(): void {
  const es = new EventSource('/events');
  es.addEventListener('open', () => setConn('live'));
  es.addEventListener('error', () => setConn(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting'));
  es.addEventListener('state', (ev: MessageEvent<string>) => {
    try {
      const data = JSON.parse(ev.data) as EntityState;
      if (typeof data.id !== 'string') return;
      store.set(data.id, { ...store.get(data.id), ...data });
      scheduleRender();
    } catch {
      /* unvollständige Nachricht ignorieren */
    }
  });
  // EventSource verbindet sich selbst neu; bei endgültigem Abbruch neu starten
  es.addEventListener('error', () => {
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
  });
}

function setConn(c: ConnState): void {
  conn = c;
  scheduleRender();
}

async function post(id: EntityId, action: string, value?: string | number): Promise<boolean> {
  const [domain, name] = id.split('/') as [string, string];
  let url = `/${domain}/${encodeURIComponent(name)}/${action}`;
  if (value !== undefined) url += `?value=${encodeURIComponent(String(value))}`;
  try {
    const res = await fetch(url, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Aufbau der Seite
// ---------------------------------------------------------------------------

const ICON = {
  sun: '<path d="M12 3v2M12 19v2M5.6 5.6 7 7M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4 7 17M17 7l1.4-1.4"/><circle cx="12" cy="12" r="4"/>',
  home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/>',
  grid: '<path d="M8 21 12 3l4 18M6.5 9h11M5 15h14"/>',
  battery: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 11v2"/>',
  gauge: '<path d="M12 14l3-3"/><path d="M3.5 17a9 9 0 1 1 17 0"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/>',
};

function icon(name: keyof typeof ICON, cls = 'size-5'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

const card = 'rounded-2xl bg-slate-800/80 p-4';
const label = 'text-sm text-slate-400';
const btn =
  'rounded-xl bg-slate-700 px-4 py-2.5 text-sm font-medium text-slate-100 active:scale-[0.98] disabled:opacity-50';
const btnPrimary =
  'rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white active:scale-[0.98] disabled:opacity-50';
const input =
  'w-full rounded-xl border border-slate-600 bg-slate-900 px-3 py-2.5 text-base text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none';

// Ring: 270°-Bogen wie am Display
const RING_R = 88;
const RING_LEN = 2 * Math.PI * RING_R * 0.75;

function template(): string {
  return `
  <div class="mx-auto max-w-md px-4 pb-28 pt-5">
    <header class="mb-5 flex items-start justify-between">
      <div>
        <h1 class="text-xl font-semibold">PV Display</h1>
        <p class="${label}" data-ref="eday">&nbsp;</p>
      </div>
      <div class="flex items-center gap-2 rounded-full bg-slate-800 px-3 py-1.5 text-sm" data-ref="connPill">
        <span class="size-2 rounded-full bg-slate-500" data-ref="connDot"></span>
        <span data-ref="connText">Verbinde …</span>
      </div>
    </header>

    <main data-view="overview" class="space-y-4">
      <section class="${card} flex flex-col items-center">
        <div class="relative size-56">
          <svg viewBox="0 0 200 200" class="size-full -rotate-[225deg]" aria-hidden="true">
            <circle cx="100" cy="100" r="${RING_R}" fill="none" stroke="#1e293b" stroke-width="14"
              stroke-linecap="round" stroke-dasharray="${RING_LEN} 999"/>
            <circle data-ref="ring" cx="100" cy="100" r="${RING_R}" fill="none" stroke="#facc15" stroke-width="14"
              stroke-linecap="round" stroke-dasharray="0 999" class="transition-[stroke-dasharray] duration-700"/>
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <span class="${label}">PV-Leistung</span>
            <span class="text-5xl font-bold tabular-nums text-yellow-400" data-ref="pv">--</span>
            <span class="text-lg text-slate-400" data-ref="pvUnit">kW</span>
          </div>
        </div>
        <p class="-mt-4 text-sm text-emerald-400" data-ref="autarky">&nbsp;</p>
      </section>

      <section class="grid grid-cols-3 gap-3">
        <div class="${card} px-3">
          <div class="flex items-center gap-1.5 ${label}">${icon('home', 'size-4')} Haus</div>
          <div class="mt-2 flex items-baseline gap-1">
            <span class="text-2xl font-bold tabular-nums" data-ref="load">--</span>
            <span class="text-sm text-slate-400" data-ref="loadUnit">kW</span>
          </div>
          <div class="text-xs text-slate-500">Verbrauch</div>
        </div>
        <div class="${card} px-3">
          <div class="flex items-center gap-1.5 ${label}">${icon('grid', 'size-4')} Netz</div>
          <div class="mt-2 flex items-baseline gap-1">
            <span class="text-2xl font-bold tabular-nums" data-ref="grid">--</span>
            <span class="text-sm text-slate-400" data-ref="gridUnit">kW</span>
          </div>
          <div class="text-xs text-slate-500" data-ref="gridSub">&nbsp;</div>
        </div>
        <div class="${card} px-3">
          <div class="flex items-center gap-1.5 ${label}">${icon('battery', 'size-4')} Akku</div>
          <div class="mt-2 text-2xl font-bold tabular-nums" data-ref="soc">--</div>
          <div class="truncate text-xs text-slate-500" data-ref="akkuSub">kein Akku</div>
        </div>
      </section>

      <section class="${card}">
        <h2 class="mb-2 ${label}">Energiefluss</h2>
        ${flowSvg()}
      </section>
    </main>

    <main data-view="settings" class="hidden space-y-4">
      <section class="${card} space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="font-medium">Wechselrichter</h2>
          <span class="text-xs text-slate-500">max. 3</span>
        </div>
        <form data-ref="ipForm" class="space-y-2">
          ${[0, 1, 2]
            .map(
              (i) =>
                `<input class="${input}" name="ip${i}" inputmode="decimal" autocomplete="off" placeholder="${i === 0 ? '192.168.1.50' : 'optional'}" aria-label="Fronius IP ${i + 1}">`,
            )
            .join('')}
          <p class="hidden text-sm text-red-400" data-ref="ipError"></p>
          <div class="flex gap-2 pt-1">
            <button type="submit" class="${btnPrimary} flex-1">Speichern</button>
            <button type="button" class="${btn} flex-1" data-action="scan">Suchen</button>
          </div>
        </form>
        <p class="text-sm text-slate-400" data-ref="scanStatus"></p>
      </section>

      <section class="${card} space-y-4">
        <h2 class="font-medium">Anzeige</h2>
        <label class="block space-y-1">
          <span class="flex justify-between ${label}"><span>Helligkeit</span><span data-ref="brightnessVal"></span></span>
          <input type="range" min="10" max="100" step="5" class="w-full accent-blue-500" data-ref="brightness">
        </label>
        <label class="block space-y-1">
          <span class="${label}">Anlagenleistung gesamt (kWp)</span>
          <div class="flex gap-2">
            <input type="number" min="1" max="100" step="0.1" class="${input}" data-ref="peak">
            <button type="button" class="${btn}" data-action="savePeak">Speichern</button>
          </div>
          <span class="block text-xs text-slate-500">Bestimmt, wie weit sich der Ring füllt.</span>
        </label>
      </section>

      <section class="${card} space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="font-medium">Automatische Updates</h2>
          <button type="button" role="switch" data-ref="autoUpdate" aria-checked="false"
            class="relative h-7 w-12 rounded-full bg-slate-600 transition-colors aria-checked:bg-blue-600">
            <span class="absolute left-1 top-1 size-5 rounded-full bg-white transition-transform"></span>
          </button>
        </div>
        <p class="${label}" data-ref="fwInfo">Version –</p>
        <div class="hidden rounded-xl bg-slate-900/60 p-3 text-sm" data-ref="fwNotes"></div>
        <button type="button" class="${btn} w-full" data-ref="fwButton" data-action="firmware">Nach Updates suchen</button>
      </section>

      <section class="${card} flex gap-2">
        <button type="button" class="${btn} flex-1" data-action="restart">Neustart</button>
        <button type="button" class="${btn} flex-1" data-action="expert">Erweitert</button>
      </section>
    </main>
  </div>

  <nav class="fixed inset-x-0 bottom-0 border-t border-slate-800 bg-slate-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
    <div class="mx-auto flex max-w-md">
      <button type="button" data-tab="overview" class="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs">
        ${icon('gauge')} Übersicht
      </button>
      <button type="button" data-tab="settings" class="flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs">
        ${icon('cog')} Einstellungen
      </button>
    </div>
  </nav>

  <div data-ref="toast" class="pointer-events-none fixed inset-x-0 bottom-24 flex justify-center opacity-0 transition-opacity">
    <span class="rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900" data-ref="toastText"></span>
  </div>

  <div data-ref="updModal" class="fixed inset-0 z-50 hidden items-end justify-center bg-black/60 p-4 sm:items-center"
    role="dialog" aria-modal="true" aria-labelledby="upd-title">
    <div class="w-full max-w-sm space-y-3 rounded-2xl border border-slate-700 bg-slate-800 p-5 shadow-xl">
      <h2 id="upd-title" class="text-lg font-semibold" data-ref="updTitle"></h2>
      <p class="text-sm text-slate-300" data-ref="updText"></p>
      <div class="text-sm text-slate-300" data-ref="updSummary"></div>
      <div class="h-2 overflow-hidden rounded-full bg-slate-700" data-ref="updProgress">
        <div class="h-full w-1/3 animate-pulse rounded-full bg-blue-500"></div>
      </div>
      <div class="flex gap-2 pt-1" data-ref="updButtons">
        <button type="button" class="${btn} flex-1" data-action="updLater">Später</button>
        <button type="button" class="${btnPrimary} flex-1" data-action="updInstall">Jetzt installieren</button>
      </div>
    </div>
  </div>`;
}

// Energiefluss: PV oben, Netz links, Akku rechts, Haus unten (wie am Display)
const FLOW = {
  pv: 'M160 62 L160 120',
  grid: 'M64 120 L160 120',
  akku: 'M256 120 L160 120',
  load: 'M160 120 L160 178',
} as const;
type FlowKey = keyof typeof FLOW;

function flowSvg(): string {
  const node = (x: number, y: number, color: string, ic: keyof typeof ICON) => `
    <circle cx="${x}" cy="${y}" r="24" fill="#0f172a" stroke="${color}" stroke-width="2.5"/>
    <g transform="translate(${x - 12} ${y - 12})" color="${color}">${icon(ic, '').replace('<svg class=""', '<svg width="24" height="24"')}</g>`;
  const dot = (k: FlowKey, color: string) => `
    <circle r="5" fill="${color}" data-dot="${k}" visibility="hidden">
      <animateMotion dur="3s" repeatCount="indefinite" path="${FLOW[k]}" keyPoints="0;1" keyTimes="0;1" calcMode="linear"/>
    </circle>`;
  return `
  <svg viewBox="0 0 320 210" class="w-full" role="img" aria-label="Energiefluss">
    <g stroke="#334155" stroke-width="3" stroke-linecap="round">
      ${Object.values(FLOW).map((d) => `<path d="${d}"/>`).join('')}
    </g>
    <circle cx="160" cy="120" r="5" fill="#475569"/>
    ${node(160, 38, '#facc15', 'sun')}
    ${node(40, 120, '#94a3b8', 'grid')}
    ${node(280, 120, '#4ade80', 'battery')}
    ${node(160, 202 - 24, '#60a5fa', 'home')}
    <text x="192" y="44" fill="#facc15" font-size="15" font-weight="600" data-ref="fPv">--</text>
    <text x="40" y="165" fill="#f1f5f9" font-size="14" font-weight="600" text-anchor="middle" data-ref="fGrid">--</text>
    <text x="280" y="165" fill="#4ade80" font-size="14" font-weight="600" text-anchor="middle" data-ref="fAkku"></text>
    <text x="192" y="184" fill="#60a5fa" font-size="15" font-weight="600" data-ref="fLoad">--</text>
    ${dot('pv', '#facc15')}${dot('grid', '#f1f5f9')}${dot('akku', '#4ade80')}${dot('load', '#60a5fa')}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Darstellung aktualisieren
// ---------------------------------------------------------------------------

const root = document.createElement('div');
root.id = 'pv-app';
document.body.prepend(root);
root.innerHTML = template();

function ref<T extends Element = HTMLElement>(name: string): T {
  const el = root.querySelector<T>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`Element ${name} fehlt`);
  return el;
}

function setText(name: string, text: string): void {
  const el = ref(name);
  if (el.textContent !== text) el.textContent = text;
}

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function setFlow(k: FlowKey, w: number | null, outward: boolean): void {
  const dot = root.querySelector<SVGCircleElement>(`[data-dot="${k}"]`);
  const anim = dot?.querySelector('animateMotion');
  if (!dot || !anim) return;
  if (w === null || Math.abs(w) < 20) {
    dot.setAttribute('visibility', 'hidden');
    return;
  }
  dot.setAttribute('visibility', 'visible');
  // Mehr Leistung = schnellere Punkte (wie am Display)
  const dur = Math.max(0.8, 3.2 - Math.min(Math.abs(w) / 6000, 1) * 2.4).toFixed(1) + 's';
  if (anim.getAttribute('dur') !== dur) anim.setAttribute('dur', dur);
  const kp = outward ? '1;0' : '0;1';
  if (anim.getAttribute('keyPoints') !== kp) anim.setAttribute('keyPoints', kp);
}

function render(): void {
  // Verbindungsstatus
  const online = bool(E.online);
  const [dotCls, text] =
    conn !== 'live'
      ? conn === 'offline'
        ? ['bg-red-500', 'Getrennt']
        : ['bg-slate-500 animate-pulse', 'Verbinde …']
      : online
        ? ['bg-emerald-500', 'Live']
        : ['bg-amber-500', 'Wechselrichter fehlt'];
  ref('connDot').className = `size-2 rounded-full ${dotCls}`;
  setText('connText', text);

  const pvW = num(E.pv);
  const gridW = num(E.grid);
  const loadW = num(E.load);
  const akkuW = num(E.akku);
  const soc = num(E.soc);
  const autarky = num(E.autarky);
  const eday = num(E.eday);
  const peak = num(E.peak) ?? 10;

  // PV + Ring
  const pv = power(pvW);
  setText('pv', pv.value);
  setText('pvUnit', pv.unit);
  const frac = pvW === null ? 0 : Math.min(1, Math.max(0, pvW / (peak * 1000)));
  ref<SVGCircleElement>('ring').setAttribute('stroke-dasharray', `${(RING_LEN * frac).toFixed(1)} 999`);
  setText('autarky', autarky === null ? '' : `${autarky.toFixed(0)} % autark`);
  setText('eday', eday === null ? '' : `Heute ${eday.toFixed(1)} kWh`);

  // Kacheln
  const load = power(loadW);
  setText('load', load.value);
  setText('loadUnit', load.unit);

  const grid = power(gridW);
  setText('grid', grid.value);
  const gridState =
    gridW === null ? '' : Math.abs(gridW) < 20 ? 'ausgeglichen' : gridW > 0 ? 'Bezug' : 'Einspeisung';
  setText('gridUnit', gridW === null ? '' : grid.unit);
  setText('gridSub', gridW === null ? 'kein Zähler' : gridState);
  const gridColor =
    gridW === null || Math.abs(gridW) < 20 ? 'text-slate-100' : gridW > 0 ? 'text-red-400' : 'text-emerald-400';
  ref('grid').className = `text-2xl font-bold tabular-nums ${gridColor}`;

  setText('soc', soc === null ? '--' : `${soc.toFixed(0)}%`);
  const akkuText =
    akkuW === null ? 'kein Akku' : Math.abs(akkuW) < 20 ? 'Standby' : `${akkuW < 0 ? 'lädt' : 'entlädt'} ${powerText(akkuW)}`;
  setText('akkuSub', akkuText);

  // Energiefluss
  setText('fPv', powerText(pvW));
  setText('fGrid', gridW === null ? '' : powerText(gridW));
  ref('fGrid').setAttribute('fill', gridW !== null && gridW > 20 ? '#f87171' : gridW !== null && gridW < -20 ? '#4ade80' : '#f1f5f9');
  setText('fAkku', soc === null ? (akkuW === null ? '' : powerText(akkuW)) : `${soc.toFixed(0)} %`);
  setText('fLoad', powerText(loadW));
  setFlow('pv', pvW, false);
  setFlow('grid', gridW, gridW !== null && gridW < 0); // Einspeisung fließt nach außen
  setFlow('akku', akkuW, akkuW !== null && akkuW < 0); // Laden fließt zum Akku
  setFlow('load', loadW, false);

  renderSettings();
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

const ipForm = ref<HTMLFormElement>('ipForm');
const ipInputs = [0, 1, 2].map((i) => ipForm.elements.namedItem(`ip${i}`) as HTMLInputElement);
const brightness = ref<HTMLInputElement>('brightness');
const peakInput = ref<HTMLInputElement>('peak');
const autoUpdate = ref<HTMLButtonElement>('autoUpdate');
const fwButton = ref<HTMLButtonElement>('fwButton');

function renderSettings(): void {
  // Eingabefelder nicht überschreiben, während jemand tippt
  ipInputs.forEach((el, i) => {
    if (document.activeElement !== el && !el.dataset.dirty) el.value = str(IP_IDS[i]);
  });
  const b = num(E.brightness);
  if (b !== null && document.activeElement !== brightness) brightness.value = String(b);
  setText('brightnessVal', b === null ? '' : `${b.toFixed(0)} %`);
  const p = num(E.peak);
  if (p !== null && document.activeElement !== peakInput && !peakInput.dataset.dirty) peakInput.value = String(p);

  const au = bool(E.autoUpdate);
  autoUpdate.setAttribute('aria-checked', String(au));
  (autoUpdate.firstElementChild as HTMLElement).style.transform = au ? 'translateX(20px)' : '';

  setText('scanStatus', str(E.scanStatus));

  const fw = store.get(E.firmware);
  // ESPHome meldet "verfügbar", sobald die Nummer nur anders ist – nur neuere Versionen anbieten
  const available =
    (fw?.state ?? '').toUpperCase().includes('AVAILABLE') &&
    versionNewer(fw?.latest_version ?? '', fw?.current_version ?? '');
  const installing = (fw?.state ?? '').toUpperCase().includes('INSTALL');
  setText(
    'fwInfo',
    fw?.current_version
      ? `Version ${fw.current_version}` + (available && fw.latest_version ? ` · ${fw.latest_version} verfügbar` : '')
      : 'Version –',
  );
  fwButton.textContent = installing ? 'Installiere …' : available ? 'Update installieren' : 'Nach Updates suchen';
  fwButton.dataset.mode = available ? 'install' : 'check';
  fwButton.className = `${available ? btnPrimary : btn} w-full`;
  fwButton.disabled = installing;

  // Release-Beschreibung der gefundenen Version unter der Versionszeile
  const notesEl = ref('fwNotes');
  const notes = available ? (fw?.summary ?? '') : '';
  notesEl.classList.toggle('hidden', notes === '');
  renderNotes(notesEl, notes, fw?.latest_version ?? '');

  renderUpdateModal(fw, available, installing);
}

// ---------------------------------------------------------------------------
// Update-Hinweis: erscheint einmal pro neuer Version, "Später" merkt sich die Version
// ---------------------------------------------------------------------------

// Beschreibung aus dem Manifest: optionale Überschrift + "- "-Liste (aus den Commits).
// Wird als Text gesetzt (kein innerHTML) – Commit-Nachrichten gelten als fremder Inhalt.
const renderedNotesKey = new WeakMap<HTMLElement, string>();
function renderNotes(el: HTMLElement, summary: string, version: string): void {
  const key = `${version}\u0000${summary}`;
  if (renderedNotesKey.get(el) === key) return;
  renderedNotesKey.set(el, key);
  el.replaceChildren();
  const lines = summary.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return;

  if (version) {
    const head = document.createElement('p');
    head.className = 'mb-1 font-medium text-slate-200';
    head.textContent = `Neu in Version ${version}`;
    el.append(head);
  }
  let list: HTMLUListElement | null = null;
  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (!list) {
        list = document.createElement('ul');
        list.className = 'list-disc space-y-0.5 pl-5 text-slate-300';
        el.append(list);
      }
      const li = document.createElement('li');
      li.textContent = line.slice(2);
      list.append(li);
    } else {
      list = null;
      const p = document.createElement('p');
      p.className = 'text-slate-300';
      p.textContent = line;
      el.append(p);
    }
  }
}

const DISMISS_KEY = 'pv-upd-dismissed';
let dismissedInPage = '';

function dismissedVersion(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? dismissedInPage;
  } catch {
    return dismissedInPage;
  }
}

function renderUpdateModal(fw: EntityState | undefined, available: boolean, installing: boolean): void {
  const modal = ref('updModal');
  const latest = fw?.latest_version ?? '';
  const visible = installing || (available && latest !== '' && latest !== dismissedVersion());
  modal.classList.toggle('hidden', !visible);
  modal.classList.toggle('flex', visible);
  if (!visible) return;

  setText('updTitle', installing ? 'Update wird installiert' : `Version ${latest} verfügbar`);
  setText(
    'updText',
    installing
      ? 'Das Display lädt die neue Firmware und startet danach neu. Bitte nicht ausschalten – diese Seite verbindet sich danach selbst wieder.'
      : `Version ${latest} ist verfügbar (installiert: ${fw?.current_version ?? '–'}).` +
          (bool(E.autoUpdate) ? ' Sonst wird sie heute Nacht automatisch installiert.' : ''),
  );
  renderNotes(ref('updSummary'), installing ? '' : (fw?.summary ?? ''), installing ? '' : latest);
  ref('updProgress').classList.toggle('hidden', !installing);
  ref('updButtons').classList.toggle('hidden', installing);
}

/** true, wenn a neuer ist als b ("1.10.0" > "1.9.3", "1.5.0" > "1.5.0-beta.1"). */
function versionNewer(a: string, b: string): boolean {
  const parse = (v: string): [number[], string] => {
    const [main, pre = ''] = v.split('-', 2);
    const nums = main.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return [[nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], pre];
  };
  if (!a) return false;
  const [na, pa] = parse(a);
  const [nb, pb] = parse(b);
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return na[i] > nb[i];
  if ((pa === '') !== (pb === '')) return pa === '';
  return pa > pb;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

ipInputs.forEach((el) =>
  el.addEventListener('input', () => {
    el.dataset.dirty = '1';
    ref('ipError').classList.add('hidden');
  }),
);

ipForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const values = ipInputs.map((el) => el.value.trim());
  const invalid = values.filter((v) => v !== '' && !IPV4.test(v));
  const err = ref('ipError');
  if (values.every((v) => v === '')) {
    err.textContent = 'Mindestens eine IP-Adresse eingeben oder automatisch suchen.';
    err.classList.remove('hidden');
    return;
  }
  if (invalid.length > 0) {
    err.textContent = `Keine gültige IP-Adresse: ${invalid.join(', ')}`;
    err.classList.remove('hidden');
    return;
  }
  // Lücken schließen: "", "b" → "b", ""
  const compact = [...values.filter((v) => v !== ''), '', '', ''].slice(0, 3);
  const results = await Promise.all(compact.map((v, i) => post(IP_IDS[i], 'set', v)));
  ipInputs.forEach((el) => delete el.dataset.dirty);
  toast(results.every(Boolean) ? 'Gespeichert' : 'Speichern fehlgeschlagen');
});

brightness.addEventListener('input', () => setText('brightnessVal', `${brightness.value} %`));
brightness.addEventListener('change', () => void post(E.brightness, 'set', brightness.value));
peakInput.addEventListener('input', () => (peakInput.dataset.dirty = '1'));

autoUpdate.addEventListener('click', async () => {
  const ok = await post(E.autoUpdate, bool(E.autoUpdate) ? 'turn_off' : 'turn_on');
  if (!ok) toast('Ändern fehlgeschlagen');
});

const actions: Record<string, () => Promise<void> | void> = {
  async scan() {
    toast((await post(E.scan, 'press')) ? 'Suche gestartet' : 'Suche konnte nicht starten');
  },
  async savePeak() {
    const v = Number(peakInput.value);
    if (!Number.isFinite(v) || v < 1 || v > 100) {
      toast('Bitte einen Wert zwischen 1 und 100 kWp eingeben');
      return;
    }
    delete peakInput.dataset.dirty;
    toast((await post(E.peak, 'set', v)) ? 'Gespeichert' : 'Speichern fehlgeschlagen');
  },
  async firmware() {
    if (fwButton.dataset.mode === 'install') {
      if (!confirm('Update jetzt installieren? Das Display startet danach neu.')) return;
      toast((await post(E.firmware, 'install')) ? 'Update wird installiert …' : 'Update fehlgeschlagen');
    } else {
      // Ergebnis kommt als Status-Änderung der Update-Entität zurück
      toast((await post(E.checkUpdate, 'press')) ? 'Suche nach Updates …' : 'Prüfen fehlgeschlagen');
    }
  },
  async updInstall() {
    toast((await post(E.firmware, 'install')) ? 'Update wird installiert …' : 'Update konnte nicht starten');
  },
  updLater() {
    dismissedInPage = store.get(E.firmware)?.latest_version ?? '';
    try {
      localStorage.setItem(DISMISS_KEY, dismissedInPage);
    } catch {
      /* privater Modus: gilt dann nur bis zum Neuladen */
    }
    render();
  },
  async restart() {
    if (!confirm('Display neu starten?')) return;
    toast((await post(E.restart, 'press')) ? 'Startet neu …' : 'Neustart fehlgeschlagen');
  },
  expert() {
    // ESPHome-Standardoberfläche nachladen (braucht Internet am Handy)
    root.remove();
    document.body.className = '';
    const s = document.createElement('script');
    s.src = 'https://oi.esphome.io/v3/www.js';
    document.body.append(s);
  },
};

root.addEventListener('click', (ev) => {
  const target = (ev.target as Element).closest<HTMLElement>('[data-action],[data-tab]');
  if (!target) return;
  const action = target.dataset.action;
  if (action && actions[action]) void actions[action]();
  if (target.dataset.tab) showView(target.dataset.tab);
});

// ---------------------------------------------------------------------------
// Navigation + Hinweise
// ---------------------------------------------------------------------------

function showView(view: string): void {
  root.querySelectorAll<HTMLElement>('[data-view]').forEach((el) => el.classList.toggle('hidden', el.dataset.view !== view));
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach((el) => {
    const active = el.dataset.tab === view;
    el.classList.toggle('text-blue-400', active);
    el.classList.toggle('text-slate-400', !active);
  });
  try {
    sessionStorage.setItem('pv-view', view);
  } catch {
    /* privater Modus */
  }
}

let toastTimer: number | undefined;
function toast(msg: string): void {
  setText('toastText', msg);
  const t = ref('toast');
  t.classList.remove('opacity-0');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.add('opacity-0'), 2500);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

document.title = 'PV Display';
document.documentElement.lang = 'de';
const meta = document.createElement('meta');
meta.name = 'viewport';
meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
document.head.append(meta);
document.body.className = 'bg-slate-950 text-slate-100 antialiased';

let startView = 'overview';
try {
  if (sessionStorage.getItem('pv-view') === 'settings') startView = 'settings';
} catch {
  /* privater Modus */
}
showView(startView);
render();
connect();
