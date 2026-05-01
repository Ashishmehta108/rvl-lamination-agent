// ── TAG DEFINITIONS ──────────────────────────────────────────────────────────
const TAGS = {
    // EXTRUDER
    EXTRUDER_RPM: { addr: 401104, type: "float", fc: 3, label: "Extruder RPM", unit: "RPM", warn_hi: 80, alarm_hi: 100, section: "extruder" },
    EXTRUDER_AMP: { addr: 401108, type: "float", fc: 3, label: "Extruder Amps", unit: "A", warn_hi: 35, alarm_hi: 40, section: "extruder" },
    EXTRUDER_SPEED_PCT: { addr: 400001, type: "uint16", fc: 3, label: "Extruder Speed", unit: "%", warn_hi: 95, alarm_hi: 100, section: "extruder" },
    EXTRUDER_ON_OFF: { addr: 100, type: "bool", fc: 1, label: "Extruder ON/OFF", unit: "", warn_hi: null, alarm_hi: null, section: "extruder" },
    EXTRUDER_FAULT: { addr: 12, type: "bool", fc: 1, label: "Extruder Fault", unit: "", warn_hi: null, alarm_hi: null, section: "extruder", isFault: true },
    EXTRUDER_SPEED_VOL: { addr: 401200, type: "float", fc: 3, label: "Extruder Speed Vol", unit: "V", warn_hi: null, alarm_hi: null, section: "extruder" },

    // LAMINATOR
    LAMINATOR_MPM: { addr: 401106, type: "float", fc: 3, label: "Laminator MPM", unit: "m/min", warn_hi: 130, alarm_hi: 150, section: "laminator" },
    LAMINATOR_AMP: { addr: 401110, type: "float", fc: 3, label: "Laminator Amps", unit: "A", warn_hi: 12, alarm_hi: 15, section: "laminator" },
    LAMINATOR_SPEED_PCT: { addr: 400002, type: "uint16", fc: 3, label: "Laminator Speed", unit: "%", warn_hi: 95, alarm_hi: 100, section: "laminator" },
    LAMINATOR_ON_OFF: { addr: 101, type: "bool", fc: 1, label: "Laminator ON/OFF", unit: "", warn_hi: null, alarm_hi: null, section: "laminator" },
    LAMINATOR_FAULT: { addr: 13, type: "bool", fc: 1, label: "Laminator Fault", unit: "", warn_hi: null, alarm_hi: null, section: "laminator", isFault: true },
    LAMINATOR_SPEED_VOL: { addr: 401202, type: "float", fc: 3, label: "Laminator Speed Vol", unit: "V", warn_hi: null, alarm_hi: null, section: "laminator" },

    // WINDER
    WINDER_AMP: { addr: 401112, type: "float", fc: 3, label: "Winder Amps", unit: "A", warn_hi: 8, alarm_hi: 12, section: "winder" },
    WINDER_TENSION_PCT: { addr: 400003, type: "uint16", fc: 3, label: "Winder Tension", unit: "%", warn_hi: 80, alarm_hi: 90, section: "winder" },
    WINDER_ON_OFF: { addr: 102, type: "bool", fc: 1, label: "Winder ON/OFF", unit: "", warn_hi: null, alarm_hi: null, section: "winder" },
    WINDER_FAULT: { addr: 14, type: "bool", fc: 1, label: "Winder Fault", unit: "", warn_hi: null, alarm_hi: null, section: "winder", isFault: true },
    WINDER_TENSION_VOL: { addr: 401040, type: "float", fc: 3, label: "Winder Tension Vol", unit: "V", warn_hi: null, alarm_hi: null, section: "winder" },

    // MASTER
    MASTER_SPEED_PCT: { addr: 400000, type: "uint16", fc: 3, label: "Master Speed", unit: "%", warn_hi: 95, alarm_hi: 100, section: "master" },

    // UNWINDER
    UW_SET_TENSION: { addr: 403502, type: "uint16", fc: 3, label: "UW Set Tension", unit: "", warn_hi: null, alarm_hi: null, section: "unwinder" },
    UW_PV_TENSION: { addr: 403880, type: "uint16", fc: 3, label: "UW Actual Tension", unit: "", warn_hi: null, alarm_hi: null, section: "unwinder" },

    // PRODUCTION METERS
    RUNNING_METER: { addr: 400008, type: "float", fc: 3, label: "Running Meter", unit: "m", warn_hi: null, alarm_hi: null, section: "meters" },
    TOTAL_METER: { addr: 400010, type: "float", fc: 3, label: "Total Meter", unit: "m", warn_hi: null, alarm_hi: null, section: "meters" },

    // GSM / GRAM
    GSM_ENTRY: { addr: 401300, type: "float", fc: 3, label: "GSM Entry", unit: "g/m²", warn_hi: null, alarm_hi: null, section: "gsm" },
    GRAM_ENTRY: { addr: 403004, type: "float", fc: 3, label: "Gram Entry", unit: "g", warn_hi: null, alarm_hi: null, section: "gsm" },

    // ALARMS & SAFETY
    ALARM_IND: { addr: 125, type: "bool", fc: 1, label: "Alarm Indicator", unit: "", warn_hi: null, alarm_hi: null, section: "alarms", isFault: true },
    EMG_STOP: { addr: 9, type: "bool", fc: 1, label: "Emergency Stop", unit: "", warn_hi: null, alarm_hi: null, section: "alarms", isFault: true },

    // SPLICE
    SPLICE_ON_OFF: { addr: 111, type: "bool", fc: 1, label: "Splice ON/OFF", unit: "", warn_hi: null, alarm_hi: null, section: "splice" },
    SPLICE_SPEED: { addr: 400018, type: "uint16", fc: 3, label: "Splice Speed", unit: "", warn_hi: null, alarm_hi: null, section: "splice" },
};

// ── BUILD CARDS ───────────────────────────────────────────────────────────────
function buildCards() {
    for (const [name, tag] of Object.entries(TAGS)) {
        const grid = document.getElementById(`section-${tag.section}`);
        if (!grid) continue;

        const hasBar = tag.warn_hi !== null || tag.alarm_hi !== null;

        grid.insertAdjacentHTML('beforeend', `
            <div class="card ${tag.type === 'bool' ? 'bool-card' : ''}" id="card-${name}">
                <div class="card-name">${tag.label}</div>
                <div class="card-value err" id="val-${name}">···</div>
                <div class="card-unit">${tag.unit}</div>
                ${hasBar ? `<div class="threshold-bar" id="bar-${name}"><div class="threshold-fill" id="fill-${name}" style="width:0%"></div></div>` : ''}
                <div class="card-addr">${tag.addr}</div>
            </div>
        `);
    }
}

// ── UPDATE CARD ───────────────────────────────────────────────────────────────
function updateCard(name, tag, value) {
    const card = document.getElementById(`card-${name}`);
    const valEl = document.getElementById(`val-${name}`);
    if (!card || !valEl) return;

    // null means read error
    if (value === null || value === undefined) {
        valEl.className = 'card-value err';
        valEl.textContent = 'ERR';
        card.className = 'card';
        return;
    }

    let display, state = 'ok';

    if (tag.type === 'bool') {
        const isOn = value === 1 || value === true;
        display = isOn ? '● ON' : '○ OFF';
        if (tag.isFault) {
            state = isOn ? 'fault' : 'ok';
        } else {
            state = isOn ? 'on' : 'off';
        }
    } else {
        const decimals = tag.type === 'uint16' ? 0 : 2;
        display = Number(value).toFixed(decimals);

        if (tag.alarm_hi !== null && value >= tag.alarm_hi) state = 'alarm';
        else if (tag.warn_hi !== null && value >= tag.warn_hi) state = 'warn';
        else state = 'ok';

        // threshold bar
        const barEl = document.getElementById(`bar-${name}`);
        const fillEl = document.getElementById(`fill-${name}`);
        if (barEl && fillEl) {
            const max = tag.alarm_hi ?? tag.warn_hi;
            if (max) {
                barEl.classList.add('visible');
                const pct = Math.min(100, (value / max) * 100);
                fillEl.style.width = pct + '%';
                fillEl.style.background =
                    state === 'alarm' ? 'var(--red)' :
                        state === 'warn' ? 'var(--yellow)' :
                            'var(--green)';
            }
        }
    }

    valEl.className = 'card-value';
    valEl.textContent = display;
    card.className = `card ${state}`;
}

// ── CONN STATUS ───────────────────────────────────────────────────────────────
function setConn(state, label) {
    document.getElementById('connDot').className = `conn-dot ${state}`;
    document.getElementById('connLabel').textContent = label;
}

// ── POLL /api/data ────────────────────────────────────────────────────────────
let readCount = 0;

async function update() {
    try {
        const res = await fetch('/api/data');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        readCount = data.readCount ?? readCount;
        document.getElementById('tickCount').textContent = `read #${readCount}`;
        document.getElementById('tickTime').textContent = data.ts
            ? new Date(data.ts).toLocaleTimeString()
            : '--:--:--';

        if (!data.connected) {
            setConn('offline', data.error ? 'ERROR' : 'CONNECTING…');
        } else {
            setConn('online', 'ONLINE');
        }

        let alarms = 0, warns = 0, errors = 0;

        for (const [name, tag] of Object.entries(TAGS)) {
            const val = data.tags ? data.tags[name] : null;

            // treat null as error only when server is connected (means read failed)
            const isReadError = data.connected && (val === null || val === undefined);

            updateCard(name, tag, isReadError ? null : val);

            if (!isReadError && val !== null && val !== undefined) {
                if (tag.type !== 'bool') {
                    if (tag.alarm_hi !== null && val >= tag.alarm_hi) alarms++;
                    else if (tag.warn_hi !== null && val >= tag.warn_hi) warns++;
                } else if (tag.isFault && (val === 1 || val === true)) {
                    alarms++;
                }
            } else if (isReadError) {
                errors++;
            }
        }

        document.getElementById('sbAlarms').innerHTML =
            `Alarms: <b style="color:${alarms > 0 ? 'var(--red)' : 'var(--green)'}">${alarms}</b>`;
        document.getElementById('sbWarns').innerHTML =
            `Warns: <b style="color:${warns > 0 ? 'var(--yellow)' : 'var(--green)'}">${warns}</b>`;
        document.getElementById('sbErrors').innerHTML =
            `Errors: <b style="color:${errors > 0 ? 'var(--red)' : 'var(--text)'}">${errors}</b>`;

        // ── BACKEND PUSH STATUS ──────────────────────────────────────────────
        const lp = data.lastPush;
        const pushEl = document.getElementById('sbPush');
        if (pushEl && lp && lp.ts) {
            const time = new Date(lp.ts).toLocaleTimeString();
            if (lp.success) {
                pushEl.innerHTML = `Cloud: <b style="color:var(--green)">SYNCED</b> <small>${time}</small>`;
            } else {
                pushEl.innerHTML = `Cloud: <b style="color:var(--red)">ERROR</b> <small>${lp.error || 'FAIL'}</small>`;
            }
        }

    } catch (e) {
        console.error('Poll error:', e);
        setConn('offline', 'SERVER DOWN');
    }
}

// ── INIT ──────────────────────────────────────────────────────────────────────
buildCards();
update();                          // immediate first fetch
setInterval(update, 1000);         // then every second