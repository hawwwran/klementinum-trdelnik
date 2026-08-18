const $ = id => document.getElementById(id);

// timeZone UTC is load-bearing: data.dateOf builds Dates at midnight UTC, so
// formatting them in the viewer's zone reads back the previous day anywhere west
// of Greenwich, and disagrees with the HUD, which uses getUTC*.
const fmtDate = d => d.toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const MEAN_LABELS = { tma: 'Mean daily max', tavg: 'Mean daily temp', tmi: 'Mean daily min' };

function segControl(id, key, onPick) {
  const btns = [...document.querySelectorAll(`#${id} button`)];
  const set = value => {
    for (const b of btns) b.classList.toggle('active', b.dataset[key] === String(value));
  };
  for (const btn of btns) {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      set(btn.dataset[key]);
      onPick(btn.dataset[key]);
    });
  }
  return { set };
}

// Log-scaled slider: input runs 0..1000, value = lo * (hi/lo)^(input/1000).
function logSlider(input, output, lo, hi, fmt, onChange) {
  const val = () => lo * Math.pow(hi / lo, input.value / 1000);
  const show = () => { output.textContent = fmt(val()); };
  input.addEventListener('input', () => { show(); onChange(val()); });
  return {
    set(v) {
      input.value = Math.round(1000 * Math.log(v / lo) / Math.log(hi / lo));
      show();
    },
  };
}

// Bidirectional log slider: center = 0, each half runs log lo..hi, left half
// negative (reverse). Small dead zone around the center snaps to exactly 0.
function bidirLogSlider(input, output, lo, hi, fmt, onChange) {
  const val = () => {
    const u = (input.value - 500) / 500;
    if (Math.abs(u) < 0.02) return 0;
    return Math.sign(u) * lo * Math.pow(hi / lo, Math.abs(u));
  };
  const show = () => { output.textContent = fmt(val()); };
  input.addEventListener('input', () => { show(); onChange(val()); });
  return {
    set(v) {
      const u = v === 0 ? 0 : Math.sign(v) * (Math.log(Math.abs(v) / lo) / Math.log(hi / lo));
      input.value = Math.round(500 + 500 * Math.max(-1, Math.min(1, u)));
      show();
    },
  };
}

function numSlider(input, output, fmt, onChange) {
  const show = () => { output.textContent = fmt(+input.value); };
  input.addEventListener('input', () => { show(); onChange(+input.value); });
  return { set(v) { input.value = v; show(); } };
}

let ctl = null;

export function initUI(data, state, actions) {
  const y0 = $('y0'), y1 = $('y1'), y0v = $('y0v'), y1v = $('y1v'), fill = $('dualFill');
  y0.min = y1.min = data.startYear;
  y0.max = y1.max = data.endYear;

  const syncYears = moved => {
    let a = +y0.value, b = +y1.value;
    if (a > b) {
      if (moved === y0) { y1.value = a; b = a; } else { y0.value = b; a = b; }
    }
    state.y0 = a; state.y1 = b;
    y0v.textContent = a; y1v.textContent = b;
    const span = data.endYear - data.startYear;
    fill.style.left = `${((a - data.startYear) / span) * 100}%`;
    fill.style.right = `${(1 - (b - data.startYear) / span) * 100}%`;
  };
  y0.addEventListener('input', () => { syncYears(y0); actions.rebuild(); });
  y1.addEventListener('input', () => { syncYears(y1); actions.rebuild(); });

  ctl = {
    years: {
      set(a, b) { y0.value = a; y1.value = b; syncYears(y0); },
      bounds() {
        y0.min = y1.min = data.startYear;
        y0.max = y1.max = data.endYear;
      },
    },
    element: segControl('elementSeg', 'el', k => {
      $('statMeanLabel').textContent = MEAN_LABELS[k];
      actions.setElement(k);
    }),
    color: segControl('colorSeg', 'g', g => actions.setColorGamma(+g)),
    proj: segControl('projSeg', 'p', p => actions.setProjection(p)),
    rBase: numSlider($('bScale'), $('bScaleV'), String,
      v => { state.rBase = v; actions.rebuild(); }),
    rPerDeg: logSlider($('rScale'), $('rScaleV'), 0.05, 5, v => v.toFixed(2),
      v => { state.rPerDeg = v; actions.rebuild(); }),
    rExp: logSlider($('eScale'), $('eScaleV'), 0.4, 3, v => v.toFixed(2),
      v => { state.rExp = v; actions.rebuild(); }),
    vPerDay: logSlider($('vScale'), $('vScaleV'), 0.0001, 0.05, v => v.toPrecision(2),
      v => { state.vPerDay = v; actions.rebuild(); }),
    lineWidth: numSlider($('lwScale'), $('lwScaleV'), v => v.toFixed(1),
      v => { state.lineWidth = v; actions.setLineWidth(v); }),
    fade: numSlider($('opScale'), $('opScaleV'), v => v.toFixed(2),
      v => actions.setFade(v)),
    speed: bidirLogSlider($('pSpeed'), $('pSpeedV'), 30, 20000, v => String(Math.round(v)),
      v => actions.setSpeed(v)),
  };

  $('playBtn').addEventListener('click', actions.togglePlay);
  $('stopBtn').addEventListener('click', actions.stopPlay);
  $('saveBtn').addEventListener('click', actions.saveImage);

  $('viewTop').addEventListener('click', actions.viewTop);
  $('viewFront').addEventListener('click', actions.viewFront);
  $('viewFit').addEventListener('click', actions.fit);
  $('resetBtn').addEventListener('click', actions.reset);

  const { cLo, cHi } = actions.ramp;
  for (const el of document.querySelectorAll('#legendTicks span')) {
    const t = +el.dataset.t;
    el.style.left = `${((t - cLo) / (cHi - cLo)) * 100}%`;
  }
  setLegend(actions.ramp);
}

// Pushes state + mode selections into every control (used at boot and by Reset).
export function syncControls(state, element, gamma, projection) {
  ctl.years.set(state.y0, state.y1);
  ctl.rBase.set(state.rBase);
  ctl.rPerDeg.set(state.rPerDeg);
  ctl.rExp.set(state.rExp);
  ctl.vPerDay.set(state.vPerDay);
  ctl.lineWidth.set(state.lineWidth);
  ctl.fade.set(state.fade);
  ctl.speed.set(state.speed);
  ctl.element.set(element);
  ctl.color.set(gamma);
  ctl.proj.set(projection);
  $('statMeanLabel').textContent = MEAN_LABELS[element];
}

// After a refresh has appended days, the grid can span one more year than the
// slider was built for.
export function setYearBounds() {
  ctl.years.bounds();
}

export function setLegend(ramp) {
  $('legendBar').style.background = ramp.css();
}

// Footer line: how current the data is, plus what the on-load CHMI refresh did
// (or why it could not run).
export function setFreshness(data) {
  const r = data.refresh || {};
  const bits = [`Data through ${fmtDate(new Date(data.meta.end + 'T00:00:00Z'))}`];
  if (r.ok === null) {
    bits.push('checking ČHMÚ');
  } else if (r.updated) {
    bits.push(r.days_added ? `+${r.days_added} new day${r.days_added > 1 ? 's' : ''}` : 'values revised');
  } else if (r.ok === false) {
    bits.push(r.reason);
  }
  const el = $('freshness');
  el.textContent = bits.join(' · ');
  el.classList.toggle('stale', r.ok === false);
}

export function setStats(stats, data) {
  $('statMax').textContent = `${stats.tMax.toFixed(1)} °C`;
  $('statMaxD').textContent = fmtDate(data.dateOf(stats.tMaxI));
  $('statMin').textContent = `${stats.tMin.toFixed(1)} °C`;
  $('statMinD').textContent = fmtDate(data.dateOf(stats.tMinI));
  $('statMean').textContent = `${stats.mean.toFixed(1)} °C`;
  $('statDays').textContent = stats.missing
    ? `${stats.nValid.toLocaleString('en')} (${stats.missing} missing)`
    : stats.nValid.toLocaleString('en');
}

export function tooltipText(date, temp) {
  return `${fmtDate(date)} · ${temp.toFixed(1)} °C`;
}
