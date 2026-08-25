import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceArea, CartesianGrid,
} from "recharts";
import {
  TrendingUp, TrendingDown, Minus, X, Sparkles, SlidersHorizontal,
  Info, RefreshCw, Send, ArrowUpRight, AlertTriangle,
  DollarSign, Package, Gauge, Shield,
} from "lucide-react";
import { PREBAKED, CHAT_PROMPTS } from "./prebaked";

/* ------------------------------------------------------------------ */
/*  Model: 9 KPIs across 4 lenses                                      */
/* ------------------------------------------------------------------ */

const fmtMoney = (v) => (v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : "$" + Math.round(v / 1000) + "k");
const fmtPct0 = (v) => Math.round(v) + "%";
const fmtPct1 = (v) => v.toFixed(1) + "%";
const fmtPct2 = (v) => v.toFixed(2) + "%";
const fmtUnits = (v) => (v >= 0 ? "+" : "") + Math.round(v);
const fmtNum = (v) => v.toFixed(0);

const LENSES = [
  { key: "revenue",     label: "Revenue",     abbr: "Re", icon: DollarSign },
  { key: "product",     label: "Product",     abbr: "Pr", icon: Package },
  { key: "operational", label: "Operational", abbr: "Op", icon: Gauge },
  { key: "risk",        label: "Risk",        abbr: "Ri", icon: Shield },
];

const KPIS = [
  { key: "tpv",         lens: "revenue",     label: "Processing volume (TPV)", dir: "up",   min: 250000, max: 6000000, def: 12, fmt: fmtMoney,  signal: "lagging" },
  { key: "nrr",         lens: "revenue",     label: "Net revenue retention",   dir: "up",   min: 80,     max: 125,     def: 16, fmt: fmtPct0,   signal: "lagging" },
  { key: "expansion",   lens: "revenue",     label: "Net units added (QoQ)",   dir: "up",   min: -60,    max: 320,     def: 12, fmt: fmtUnits,  signal: "leading" },
  { key: "adoption",    lens: "product",     label: "Resident payment adoption", dir: "up", min: 32,     max: 92,      def: 15, fmt: fmtPct0,   signal: "leading" },
  { key: "autopay",     lens: "product",     label: "Autopay enrollment",      dir: "up",   min: 16,     max: 78,      def: 7,  fmt: fmtPct0,   signal: "leading" },
  { key: "success",     lens: "operational", label: "Payment success rate",    dir: "up",   min: 89,     max: 99.6,    def: 8,  fmt: fmtPct1,   signal: "leading" },
  { key: "tickets",     lens: "operational", label: "Support tickets / 1k txns", dir: "down", min: 3,    max: 40,      def: 4,  fmt: fmtNum,    signal: "leading" },
  { key: "chargeback",  lens: "risk",        label: "Chargeback rate",         dir: "down", min: 0.1,    max: 2.5,     def: 13, fmt: fmtPct2,   signal: "leading" },
  { key: "delinquency", lens: "risk",        label: "Delinquency rate",        dir: "down", min: 2,      max: 18,      def: 13, fmt: fmtPct0,   signal: "leading" },
];

const THRESHOLDS = [
  { grade: "A", min: 85 }, { grade: "B", min: 70 }, { grade: "C", min: 55 }, { grade: "D", min: 0 },
];

function subscore(kpi, value) {
  const t = (value - kpi.min) / (kpi.max - kpi.min);
  const c = Math.max(0, Math.min(1, t));
  return (kpi.dir === "up" ? c : 1 - c) * 100;
}
function blend(client, qi, weights, kpiList) {
  let acc = 0, wsum = 0;
  kpiList.forEach((k) => {
    const idx = KPIS.indexOf(k);
    acc += subscore(k, client.quarters[qi][k.key]) * weights[idx];
    wsum += weights[idx];
  });
  return wsum ? acc / wsum : 0;
}
function compositeAt(client, qi, weights) { return blend(client, qi, weights, KPIS); }
function lensAt(client, qi, weights, lensKey) {
  return blend(client, qi, weights, KPIS.filter((k) => k.lens === lensKey));
}
function seriesFor(client, weights) { return client.quarters.map((_, qi) => compositeAt(client, qi, weights)); }
function gradeFor(score) { for (const t of THRESHOLDS) if (score >= t.min) return t.grade; return "D"; }
function projectNext(series) {
  const slope = (series[3] - series[0]) / 3;
  return Math.max(0, Math.min(100, series[3] + slope));
}
function atRiskTPV(client, score) {
  const pct = Math.max(0, Math.min(0.6, (85 - score) / 85));
  return client.quarters[3].tpv * pct;
}
// Post-mortem helpers (D-graded clients): where the trajectory broke, and the KPI signature behind it
function inflectionQuarter(series) {
  let qi = 1, drop = Infinity;
  for (let i = 1; i < series.length; i++) { const d = series[i] - series[i - 1]; if (d < drop) { drop = d; qi = i; } }
  return { qi, drop };
}
function decliningKPIs(client, n = 3) {
  return KPIS
    .map((k) => ({ k, drop: subscore(k, client.quarters[0][k.key]) - subscore(k, client.quarters[3][k.key]) }))
    .filter((x) => x.drop > 3)
    .sort((a, b) => b.drop - a.drop)
    .slice(0, n);
}

/* ------------------------------------------------------------------ */
/*  Synthetic data — quality trajectory + independent size            */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const ARCH = {
  strong_stable:   { q0: 0.90, dq:  0.00, g:  0.03, sizeLo: 0.60, sizeHi: 1.00, vol: 0.03 },
  strong_rising:   { q0: 0.74, dq:  0.055, g:  0.11, sizeLo: 0.50, sizeHi: 0.95, vol: 0.04 },
  strong_slipping: { q0: 0.93, dq: -0.075, g: -0.02, sizeLo: 0.60, sizeHi: 1.00, vol: 0.04 },
  healthy_stable:  { q0: 0.75, dq:  0.006, g:  0.03, sizeLo: 0.35, sizeHi: 0.78, vol: 0.03 },
  mid_stable:      { q0: 0.60, dq:  0.00, g:  0.02, sizeLo: 0.30, sizeHi: 0.72, vol: 0.04 },
  mid_rising:      { q0: 0.50, dq:  0.06, g:  0.09, sizeLo: 0.28, sizeHi: 0.70, vol: 0.04 },
  weak_recovering: { q0: 0.40, dq:  0.085, g:  0.06, sizeLo: 0.12, sizeHi: 0.50, vol: 0.05 },
  weak_declining:  { q0: 0.56, dq: -0.10, g: -0.06, sizeLo: 0.20, sizeHi: 0.55, vol: 0.05 },
  volatile:        { q0: 0.60, dq:  0.00, g:  0.01, sizeLo: 0.35, sizeHi: 0.80, vol: 0.13 },
};

const ROSTER = [
  ["Larkspur Residential",      "Multifamily",     "strong_stable"],
  ["Ironwood Property Group",   "Commercial",      "strong_rising"],
  ["Meridian Living",           "Multifamily",     "strong_slipping"],
  ["Cobalt HOA Services",       "HOA",             "healthy_stable"],
  ["Harborview Communities",    "Mixed-use",       "healthy_stable"],
  ["Sagebrook Management",      "Student housing", "weak_recovering"],
  ["Northgate Realty Partners", "Commercial",      "weak_declining"],
  ["Willowmere Estates",        "HOA",             "mid_stable"],
  ["Brightpath Housing Co.",    "Multifamily",     "strong_rising"],
  ["Kestrel Commercial",        "Commercial",      "healthy_stable"],
  ["Elmcrest Property Mgmt",    "Mixed-use",       "weak_declining"],
  ["Vantage Multifamily",       "Multifamily",     "volatile"],
  ["Copperline Residences",     "Student housing", "strong_stable"],
  ["Fernbank Communities",      "HOA",             "mid_stable"],
  ["Slate & Oak Realty",        "Commercial",      "weak_recovering"],
  ["Tidewater Living",          "Mixed-use",       "strong_slipping"],
];

const CLIENTS = ROSTER.map(([name, sector, archKey], i) => {
  const a = ARCH[archKey];
  const rng = mulberry32((i + 1) * 2654435761);
  const n = () => (rng() - 0.5) * 2;
  const sizeBase = a.sizeLo + rng() * (a.sizeHi - a.sizeLo);
  const tpvBase = 250000 + sizeBase * 5750000;
  const quarters = [];
  for (let q = 0; q < 4; q++) {
    const ql = clamp(a.q0 + a.dq * q + n() * a.vol, 0.05, 0.98);
    quarters.push({
      tpv:         clamp(tpvBase * Math.pow(1 + a.g, q) * (1 + n() * 0.04), 120000, 6400000),
      nrr:         clamp(80 + ql * 45 + n() * 3, 78, 126),
      expansion:   clamp(-40 + ql * 300 + n() * 30, -70, 340),
      adoption:    clamp(32 + ql * 60 + n() * 3, 28, 94),
      autopay:     clamp(16 + ql * 62 + n() * 3, 12, 80),
      success:     clamp(89 + ql * 10.5 + n() * 0.4, 87, 99.7),
      tickets:     clamp(40 - ql * 36 + n() * 2, 2, 44),
      chargeback:  clamp(2.5 - ql * 2.35 + n() * 0.12, 0.08, 2.6),
      delinquency: clamp(18 - ql * 16 + n() * 1.2, 1.5, 19),
    });
  }
  return { id: "c" + i, name, sector, quarters };
});

const QLABELS = ["Q1", "Q2", "Q3", "Q4"];

/* ------------------------------------------------------------------ */
/*  Visual tokens                                                      */
/* ------------------------------------------------------------------ */

const GRADE = {
  A: { chip: "bg-emerald-500", text: "text-emerald-600", stroke: "#059669", band: "#ecfdf5" },
  B: { chip: "bg-sky-500",     text: "text-sky-600",     stroke: "#0284c7", band: "#f0f9ff" },
  C: { chip: "bg-amber-500",   text: "text-amber-600",   stroke: "#d97706", band: "#fffbeb" },
  D: { chip: "bg-rose-500",    text: "text-rose-600",    stroke: "#e11d48", band: "#fff1f2" },
};

function GradeMark({ g, size = "md" }) {
  const s = size === "lg" ? "h-14 w-14 text-3xl" : size === "sm" ? "h-6 w-6 text-xs" : "h-10 w-10 text-xl";
  return <div className={`${GRADE[g].chip} ${s} grid place-items-center rounded-xl font-mono font-bold text-white shadow-sm`}>{g}</div>;
}
function Delta({ v, label }) {
  const r = Math.round(v);
  if (Math.abs(r) < 1) return <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-400"><Minus className="h-3 w-3" />0{label && <span className="text-slate-400"> {label}</span>}</span>;
  const up = r > 0;
  return <span className={`inline-flex items-center gap-0.5 font-mono text-xs ${up ? "text-emerald-600" : "text-rose-600"}`}>{up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{up ? "+" : ""}{r}{label && <span className="ml-0.5 text-slate-400">{label}</span>}</span>;
}
function Sparkline({ data, stroke }) {
  const w = 92, h = 26, pad = 3;
  const min = Math.min(...data), max = Math.max(...data), rng = max - min || 1;
  const pts = data.map((d, i) => `${(pad + (i / (data.length - 1)) * (w - pad * 2)).toFixed(1)},${(h - pad - ((d - min) / rng) * (h - pad * 2)).toFixed(1)}`).join(" ");
  const lx = pad + (w - pad * 2), ly = h - pad - ((data[data.length - 1] - min) / rng) * (h - pad * 2);
  return <svg width={w} height={h}><polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" /><circle cx={lx} cy={ly} r="2.4" fill={stroke} /></svg>;
}

/* ------------------------------------------------------------------ */
/*  Anthropic API                                                      */
/* ------------------------------------------------------------------ */

function buildContext(client, weights) {
  const series = seriesFor(client, weights);
  const score = series[3], g = gradeFor(score);
  const proj = projectNext(series), pg = gradeFor(proj);
  const risk = atRiskTPV(client, score);
  const lensLines = LENSES.map((L) => { const ls = lensAt(client, 3, weights, L.key); return `  - ${L.label}: ${Math.round(ls)}/100 (${gradeFor(ls)})`; }).join("\n");
  const kpiLines = KPIS.map((k) => `  - ${k.label}: ${k.fmt(client.quarters[3][k.key])} (sub-score ${Math.round(subscore(k, client.quarters[3][k.key]))}/100)`).join("\n");
  const trend = QLABELS.map((q, i) => `${q} ${Math.round(series[i])}(${gradeFor(series[i])})`).join(" → ");
  return `Client: ${client.name} — ${client.sector} property manager on a payments platform.
Overall health grade: ${g} (composite ${Math.round(score)}/100), revenue-weighted.
Quarterly trend: ${trend}. Simple trend projection next quarter: ${Math.round(proj)} (${pg}).
Estimated at-risk processing volume: ${fmtMoney(risk)} of quarterly TPV.
Per-lens sub-scores:\n${lensLines}
Current-quarter KPIs:\n${kpiLines}`;
}

// Static public demo: the health read, post-mortem, and chat are pre-generated
// (see prebaked.js) so the app runs with no API key. The deterministic scoring,
// the live weight sliders, and every calculation below remain fully interactive.

/* ------------------------------------------------------------------ */
/*  Detail modal                                                       */
/* ------------------------------------------------------------------ */

function DetailModal({ client, weights, onClose }) {
  const series = useMemo(() => seriesFor(client, weights), [client, weights]);
  const score = series[3], g = gradeFor(score);
  const proj = useMemo(() => projectNext(series), [series]);
  const pg = gradeFor(proj);
  const risk = atRiskTPV(client, score);
  const ctx = useMemo(() => buildContext(client, weights), [client, weights]);

  const baked = PREBAKED[client.id] || {};
  const narrative = baked.read || "";
  const narrLoading = false, narrError = "";

  // Post-mortem (D-graded only): deterministic inflection + KPI signature, narrated once (pre-baked)
  const isD = g === "D";
  const inflection = useMemo(() => (isD ? inflectionQuarter(series) : null), [isD, series]);
  const declined = useMemo(() => (isD ? decliningKPIs(client) : []), [isD, client]);
  const postmortem = isD ? (baked.postmortem || "") : "";
  const pmLoading = false, pmError = "";

  // Chat is pre-baked example exchanges in this static demo (see note below the thread)
  const chatExchanges = baked.chat || [];
  const scrollRef = useRef(null);

  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const chartData = [
    ...series.map((s, i) => ({ q: QLABELS[i], score: Math.round(s), proj: i === 3 ? Math.round(s) : null })),
    { q: "Q5 ⋯", score: null, proj: Math.round(proj) },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-3 backdrop-blur-sm sm:p-4" onClick={onClose}>
      <div className="my-3 w-full max-w-4xl rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 p-5">
          <div className="flex items-center gap-4">
            <GradeMark g={g} size="lg" />
            <div>
              <h2 className="text-lg font-semibold tracking-tight text-slate-900">{client.name}</h2>
              <p className="text-sm text-slate-500">{client.sector} · revenue-weighted grade · as of {QLABELS[3]} 2025</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-sm text-slate-700">{Math.round(score)}/100</span>
                <Delta v={series[3] - series[2]} label="vs Q3" />
                <span className="inline-flex items-center gap-1 font-mono text-xs text-slate-500">projected <span className={`rounded px-1 font-bold text-white ${GRADE[pg].chip}`}>{pg}</span></span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="h-5 w-5" /></button>
        </div>

        {/* at-risk banner */}
        {g !== "A" && (
          <div className="mx-5 mt-4 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span><span className="font-mono font-semibold">{fmtMoney(risk)}</span> of quarterly processing volume flagged at-risk at this grade <span className="text-amber-600">(est.)</span></span>
          </div>
        )}

        <div className="grid gap-5 p-5 md:grid-cols-2">
          {/* left */}
          <div className="space-y-5">
            {/* lens sub-scores */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Health by lens</h3>
              <div className="grid grid-cols-2 gap-2">
                {LENSES.map((L) => {
                  const ls = lensAt(client, 3, weights, L.key), lg = gradeFor(ls);
                  return (
                    <div key={L.key} className="flex items-center gap-2.5 rounded-xl bg-slate-50 p-2.5 ring-1 ring-slate-100">
                      <GradeMark g={lg} size="sm" />
                      <div className="leading-tight">
                        <p className="text-sm font-medium text-slate-700">{L.label}</p>
                        <p className="font-mono text-xs text-slate-400">{Math.round(ls)}/100</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* trend chart */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Composite trend + projection</h3>
              <div className="h-40 w-full rounded-xl bg-slate-50 p-2 ring-1 ring-slate-100">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -22 }}>
                    <ReferenceArea y1={85} y2={100} fill={GRADE.A.band} /><ReferenceArea y1={70} y2={85} fill={GRADE.B.band} />
                    <ReferenceArea y1={55} y2={70} fill={GRADE.C.band} /><ReferenceArea y1={0} y2={55} fill={GRADE.D.band} />
                    <CartesianGrid vertical={false} stroke="#e2e8f0" strokeDasharray="2 2" />
                    <XAxis dataKey="q" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(v) => [v + "/100 · " + gradeFor(v), "Score"]} />
                    <Line type="monotone" dataKey="score" stroke={GRADE[g].stroke} strokeWidth={2.5} dot={{ r: 3, fill: GRADE[g].stroke }} connectNulls />
                    <Line type="monotone" dataKey="proj" stroke={GRADE[pg].stroke} strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-1 text-xs text-slate-400">Dashed = simple trend projection, not a forecast model.</p>
            </div>

            {/* Where the decline set in — D-graded only */}
            {isD && (
              <div className="rounded-xl border border-rose-100 bg-rose-50 p-4">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-rose-700">
                  <TrendingDown className="h-3.5 w-3.5" /> Where the decline set in
                </div>
                {inflection && (
                  <p className="mb-2 text-sm text-slate-700">
                    Steepest drop landed in <span className="font-mono font-semibold text-rose-700">{QLABELS[inflection.qi]}</span>
                    {declined.length > 0 && <>, led by {declined.map((d) => d.k.label).join(", ")}</>}.
                  </p>
                )}
                {pmLoading ? <p className="text-sm text-rose-400">Reconstructing the decline…</p>
                  : pmError ? <p className="text-sm text-rose-500">{pmError}</p>
                  : postmortem ? <p className="text-sm leading-relaxed text-slate-700">{postmortem}</p>
                  : null}
              </div>
            )}
          </div>

          {/* right */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-violet-100 bg-violet-50 p-4">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-violet-700"><Sparkles className="h-3.5 w-3.5" /> Health read &amp; action</div>
              <p className="text-sm leading-relaxed text-slate-700">{narrative}</p>
            </div>
            <div className="flex min-h-0 flex-1 flex-col rounded-xl bg-slate-50 ring-1 ring-slate-100">
              <div className="border-b border-slate-100 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Ask about this client</div>
              <div ref={scrollRef} className="max-h-64 min-h-[6.5rem] flex-1 space-y-3 overflow-y-auto p-4">
                {chatExchanges.map((ex, i) => (
                  <div key={i} className="space-y-3">
                    <div className="flex justify-end"><div className="max-w-[85%] rounded-2xl bg-slate-800 px-3 py-2 text-sm leading-relaxed text-white">{ex.q}</div></div>
                    <div className="flex justify-start"><div className="max-w-[85%] rounded-2xl bg-white px-3 py-2 text-sm leading-relaxed text-slate-700 ring-1 ring-slate-200">{ex.a}</div></div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-2.5">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <p className="text-xs leading-relaxed text-slate-500">Example exchanges from the live tool, frozen for this public demo. In the working version this chat runs on Claude against each client's data — happy to give a live walkthrough.</p>
              </div>
            </div>
          </div>
        </div>

        {/* KPI breakdown grouped by lens */}
        <div className="border-t border-slate-100 p-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">KPI breakdown · {QLABELS[3]}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {LENSES.map((L) => (
              <div key={L.key} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-100">
                <p className="mb-2 text-xs font-semibold text-slate-500">{L.label}</p>
                <div className="space-y-2">
                  {KPIS.filter((k) => k.lens === L.key).map((k) => {
                    const idx = KPIS.indexOf(k), val = client.quarters[3][k.key], ss = subscore(k, val);
                    const wpct = Math.round((weights[idx] / weights.reduce((a, b) => a + b, 0)) * 100);
                    return (
                      <div key={k.key}>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-slate-600">{k.label}</span>
                          <span className="font-mono font-medium text-slate-900">{k.fmt(val)}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-slate-700" style={{ width: ss + "%" }} /></div>
                          <span className="w-14 text-right font-mono text-[11px] text-slate-500">{Math.round(ss)}/100</span>
                          <span className="w-8 text-right font-mono text-[11px] text-slate-400">{wpct}%</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Scoring model panel                                                */
/* ------------------------------------------------------------------ */

function SignalTag({ signal }) {
  const leading = signal === "leading";
  return (
    <span
      className={`ml-1.5 inline-flex items-center rounded px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wide ${leading ? "bg-slate-800 text-white" : "text-slate-400 ring-1 ring-slate-200"}`}
      title={leading ? "Leading indicator — tends to move before revenue does" : "Lagging indicator — confirms what already happened"}
    >
      {leading ? "Lead" : "Lag"}
    </span>
  );
}

function ModelPanel({ weights, setWeights, open, setOpen }) {
  const total = weights.reduce((a, b) => a + b, 0);
  return (
    <div className="rounded-2xl border border-slate-200 bg-white">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-5 py-3.5">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 text-violet-600" />
          <span className="text-sm font-semibold text-slate-800">Scoring model</span>
          <span className="hidden text-xs text-slate-400 sm:inline">— adjust the weights, the whole portfolio re-grades live</span>
        </div>
        <span className="font-mono text-xs text-slate-400">{open ? "hide" : "edit"}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100 p-5">
          <div className="mb-5 rounded-xl bg-slate-50 p-3.5 text-xs leading-relaxed text-slate-600">
            <span className="font-semibold text-slate-700">Why these weights.</span> Each KPI is weighted by its predictive power toward churn × how much revenue it puts at stake — not abstract importance. The model tilts deliberately toward <span className="font-semibold text-slate-800">leading</span> signals (adoption, delinquency, chargebacks, net units) over <span className="font-semibold text-slate-800">lagging</span> ones (TPV, NRR), because the grade is an early-warning signal: it should move <em>before</em> revenue does. TPV is capped at 12% so account size doesn't double-count — the grade measures health, while at-risk TPV separately scales what's at stake. In production these weights would be validated by regressing churned vs retained clients on each KPI; here they're a reasoned hypothesis.
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            {LENSES.map((L) => {
              const lensPct = KPIS.filter((k) => k.lens === L.key).reduce((a, k) => a + weights[KPIS.indexOf(k)], 0) / total * 100;
              return (
                <div key={L.key}>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{L.label}</span>
                    <span className="font-mono text-xs text-slate-400">{Math.round(lensPct)}% of grade</span>
                  </div>
                  <div className="space-y-2.5">
                    {KPIS.filter((k) => k.lens === L.key).map((k) => {
                      const idx = KPIS.indexOf(k), pct = Math.round((weights[idx] / total) * 100);
                      return (
                        <div key={k.key}>
                          <div className="mb-1 flex items-center justify-between text-sm"><span className="flex items-center text-slate-600">{k.label}<SignalTag signal={k.signal} /></span><span className="font-mono text-xs text-slate-500">{pct}%</span></div>
                          <input type="range" min="0" max="30" value={weights[idx]} onChange={(e) => { const w = [...weights]; w[idx] = Number(e.target.value); setWeights(w); }} className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-violet-600" />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <div className="flex items-center gap-3">
              {[["A", "85–100"], ["B", "70–84"], ["C", "55–69"], ["D", "0–54"]].map(([g, r]) => (
                <span key={g} className="flex items-center gap-1.5"><GradeMark g={g} size="sm" /><span className="font-mono text-xs text-slate-500">{r}</span></span>
              ))}
            </div>
            <button onClick={() => setWeights(KPIS.map((k) => k.def))} className="text-xs font-medium text-violet-600 hover:text-violet-700">Reset to default model</button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">Each KPI is scored 0–100, then blended by weight into one composite grade. Weights are normalized, so they never need to sum to 100. The headline grade is revenue-weighted; each lens sub-score blends only its own KPIs.</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Needs-attention strip — salvageable (B/C) accounts sliding fastest */
/* ------------------------------------------------------------------ */

function AttentionStrip({ rows, onOpen }) {
  const items = useMemo(() =>
    rows
      .filter((r) => (r.grade === "B" || r.grade === "C") && r.delta < -1)
      .map((r) => {
        const proj = projectNext(r.series);
        const pg = gradeFor(proj);
        return { ...r, risk: atRiskTPV(r.c, r.score), proj, pg, drop: pg !== r.grade && proj < r.score };
      })
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 3),
  [rows]);

  if (items.length === 0) {
    return (
      <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <span className="font-semibold text-slate-800">Needs attention</span> — no B or C accounts are sliding this quarter. Remaining risk sits in the D tier, already flagged.
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-semibold text-slate-800">Needs attention this quarter</span>
        <span className="hidden text-xs text-slate-400 sm:inline">— salvageable accounts sliding fastest; act before they cross a grade</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {items.map((r) => (
          <button key={r.c.id} onClick={() => onOpen(r.c)} className="flex flex-col gap-2 rounded-xl bg-slate-50 p-3 text-left ring-1 ring-slate-100 transition hover:ring-slate-300 hover:shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{r.c.name}</p>
                <p className="text-xs text-slate-400">{r.c.sector}</p>
              </div>
              <GradeMark g={r.grade} size="sm" />
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Delta v={r.delta} label="vs Q3" />
              {r.drop && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-rose-600 ring-1 ring-rose-100">→ {r.pg} projected</span>
              )}
            </div>
            <div className="flex items-baseline gap-1.5 border-t border-slate-100 pt-2">
              <span className="font-mono text-sm font-semibold text-amber-600">{fmtMoney(r.risk)}</span>
              <span className="text-xs text-slate-400">at-risk TPV</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

export default function App() {
  const [weights, setWeights] = useState(KPIS.map((k) => k.def));
  const [modelOpen, setModelOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [sort, setSort] = useState("score");
  const [active, setActive] = useState(null);

  const rows = useMemo(() => {
    const r = CLIENTS.map((c) => {
      const series = seriesFor(c, weights), score = series[3];
      const lensGrades = LENSES.map((L) => ({ key: L.key, g: gradeFor(lensAt(c, 3, weights, L.key)) }));
      return { c, series, score, grade: gradeFor(score), delta: series[3] - series[2], lensGrades };
    });
    r.sort((a, b) => sort === "name" ? a.c.name.localeCompare(b.c.name) : sort === "trend" ? b.delta - a.delta : b.score - a.score);
    return r;
  }, [weights, sort]);

  const dist = useMemo(() => { const d = { A: 0, B: 0, C: 0, D: 0 }; rows.forEach((r) => d[r.grade]++); return d; }, [rows]);
  const avgRaw = rows.reduce((a, r) => a + r.score, 0) / rows.length;
  const avg = Math.round(avgRaw);
  const portfolioGrade = gradeFor(avgRaw);
  const avgDelta = rows.reduce((a, r) => a + r.delta, 0) / rows.length;
  const atRiskTotal = rows.reduce((a, r) => a + atRiskTPV(r.c, r.score), 0);
  const total = rows.length;

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 overflow-hidden rounded-lg shadow-sm">
              <div className="w-1/4 bg-emerald-500" /><div className="w-1/4 bg-sky-500" /><div className="w-1/4 bg-amber-500" /><div className="w-1/4 bg-rose-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900">Client 360 · Health Score</h1>
              <p className="text-sm text-slate-500">Ledgerline Payments · client-health across a portfolio of 16 property managers</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-white px-3 py-1 font-mono text-xs text-slate-500 ring-1 ring-slate-200">concept · synthetic data</span>
            <button onClick={() => setAboutOpen(!aboutOpen)} className="grid h-8 w-8 place-items-center rounded-full bg-white text-slate-500 ring-1 ring-slate-200 hover:text-slate-700"><Info className="h-4 w-4" /></button>
          </div>
        </header>

        {aboutOpen && (
          <div className="mb-5 space-y-2 rounded-2xl border border-violet-100 bg-violet-50 p-5 text-sm leading-relaxed text-slate-700">
            <p><span className="font-semibold">The idea.</span> One health grade (A–D) per client for a payments processor (here, a fictional one, Ledgerline) serving property managers, built from the KPIs that actually move the business, so revenue, product, engineering, and risk monitor client health in one shared language instead of five disconnected dashboards. It's designed to catch churn before net revenue retention does — NRR tells you revenue already left; this flags the leading signals (adoption, delinquency, chargebacks) while there's still time to act.</p>
            <p><span className="font-semibold">How it works.</span> Nine KPIs, each scored 0–100, are grouped into four lenses (Revenue, Product, Operational, Risk) and blended by weight into one revenue-weighted composite. Weights lean on leading indicators over lagging ones, so the grade moves before revenue does. The portfolio view surfaces a "needs attention" strip — the salvageable accounts sliding fastest — and open any client to see the four lens sub-scores, a four-quarter trend with a simple next-quarter projection, the estimated at-risk processing volume, a decline post-mortem on lost accounts, and a Claude-generated read that names the driver and the lever. The scoring is deterministic math; the AI does the judgment and the plain-English part.</p>
            <p><span className="font-semibold">Ask about any client.</span> Every client opens into a conversation — interrogate the grade, pressure-test the drivers, or ask what you'd do next, and Claude answers against that client's actual numbers. The score gets you to the "what"; the chat gets a revenue or CS team to the "so what do I do Monday" without waiting on an analyst.</p>
            <p className="text-slate-500">All companies and numbers are fabricated for demonstration. No real or proprietary data is used.</p>
          </div>
        )}

        <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            {/* portfolio health hero — the average grade is the headline */}
            <div className="flex items-center gap-4">
              <GradeMark g={portfolioGrade} size="lg" />
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-400">Portfolio health</p>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-semibold leading-none text-slate-900">{avg}</span>
                  <span className="font-mono text-sm text-slate-400">/100 avg</span>
                </div>
                <div className="mt-1"><Delta v={avgDelta} label="vs Q3" /></div>
              </div>
            </div>
            {/* supporting stats */}
            <div className="grid grid-cols-3 gap-5 sm:gap-8">
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-400">Clients</p>
                <p className="mt-1 font-mono text-2xl font-semibold text-slate-900">{total}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-400">TPV at risk</p>
                <p className="mt-1 font-mono text-2xl font-semibold text-amber-600">{fmtMoney(atRiskTotal)}</p>
              </div>
              <div>
                <p className="mb-1.5 text-xs uppercase tracking-wider text-slate-400">Grade mix</p>
                <div className="flex h-2.5 w-24 overflow-hidden rounded-full bg-slate-100">{["A", "B", "C", "D"].map((g) => dist[g] > 0 && <div key={g} className={GRADE[g].chip} style={{ width: (dist[g] / total) * 100 + "%" }} />)}</div>
                <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-0.5">{["A", "B", "C", "D"].map((g) => <span key={g} className="flex items-center gap-1 font-mono text-[11px] text-slate-500"><span className={`h-2 w-2 rounded-full ${GRADE[g].chip}`} />{g} {dist[g]}</span>)}</div>
              </div>
            </div>
          </div>
        </div>

        <AttentionStrip rows={rows} onOpen={setActive} />

        <div className="mb-4"><ModelPanel weights={weights} setWeights={setWeights} open={modelOpen} setOpen={setModelOpen} /></div>

        <div className="mb-3 flex flex-wrap items-center gap-y-2 gap-x-1">
          <span className="mr-1 text-xs text-slate-400">Sort</span>
          {[["score", "Score"], ["trend", "Momentum"], ["name", "Name"]].map(([k, l]) => (
            <button key={k} onClick={() => setSort(k)} className={`rounded-full px-3 py-1 text-xs font-medium ${sort === k ? "bg-slate-800 text-white" : "bg-white text-slate-500 ring-1 ring-slate-200 hover:text-slate-700"}`}>{l}</button>
          ))}
          <div className="ml-auto flex items-center gap-3">
            <span className="text-[11px] uppercase tracking-wider text-slate-300">Lenses</span>
            {LENSES.map((L) => { const Icon = L.icon; return (
              <span key={L.key} className="flex items-center gap-1 text-[11px] text-slate-400" title={`${L.label} lens`}>
                <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />{L.label}
              </span>
            ); })}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ c, series, score, grade, delta, lensGrades }) => (
            <button key={c.id} onClick={() => setActive(c)} className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:shadow-md">
              <div className="flex items-start justify-between">
                <div className="min-w-0"><p className="truncate font-medium text-slate-900">{c.name}</p><p className="text-xs text-slate-400">{c.sector}</p></div>
                <GradeMark g={grade} />
              </div>
              <div className="mt-3 flex items-end justify-between">
                <div><p className="font-mono text-2xl font-semibold leading-none text-slate-900">{Math.round(score)}</p><div className="mt-1"><Delta v={delta} label="vs Q3" /></div></div>
                <Sparkline data={series} stroke={GRADE[grade].stroke} />
              </div>
              <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2.5">
                {lensGrades.map((lg) => {
                  const L = LENSES.find((L) => L.key === lg.key);
                  const Icon = L.icon;
                  return (
                    <span key={lg.key} title={`${L.label}: ${lg.g}`}>
                      <Icon className={`h-3.5 w-3.5 ${GRADE[lg.g].text}`} strokeWidth={2.25} />
                    </span>
                  );
                })}
                <span className="ml-auto flex items-center gap-0.5 text-[11px] font-medium text-violet-600 opacity-0 transition group-hover:opacity-100">open <ArrowUpRight className="h-3 w-3" /></span>
              </div>
            </button>
          ))}
        </div>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-4 text-xs text-slate-400">
          <span>Deterministic scoring · trend projection · React + Recharts · narrative &amp; chat via the Claude API</span>
          <span className="font-mono">synthetic data — safe to share</span>
        </footer>
      </div>

      {active && <DetailModal client={active} weights={weights} onClose={() => setActive(null)} />}
    </div>
  );
}
