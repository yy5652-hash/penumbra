// Single content source for the PowerPoint and static HTML deck.
const THEME = { name: "Penumbra", headFontFace: "Arial", bodyFontFace: "Arial", colors: {
  dk1: "1B2B26", lt1: "FFFFFF", dk2: "10231D", lt2: "E8EFEA", accent1: "22654F", accent2: "8FA69B", accent3: "C9812B",
  accent4: "5C6E67", accent5: "B9CCC2", accent6: "3E8A70", hlink: "22654F", folHlink: "5C6E67" } };

function buildContent(pres) {
const HEX = THEME.colors;
pres.layout = "LAYOUT_WIDE";
pres.title = "Penumbra: tomorrow's solar power, with a margin";
pres.author = "Yi Yu";
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;
const SITE = "yy5652-hash.github.io/penumbra";

pres.defineSlideMaster({ title: "DARK", background: { color: C.background1 }, objects: [
  { rect: { x: 0, y: 0, w: 13.33, h: 7.5, fill: { color: C.text2 } } },
  { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.3, w: 11.2, h: 1.3, fontSize: 60, bold: true, color: C.background1, margin: 0, align: "left" }, text: "" } },
  { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 3.7, w: 11.2, h: 1.6, fontSize: 24, color: C.accent5, margin: 0, align: "left" }, text: "" } },
] });
pres.defineSlideMaster({ title: "CONTENT", background: { color: C.background1 }, objects: [
  { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.4, w: 12.1, h: 1.15, fontSize: 32, bold: true, color: C.text1, margin: 0, align: "left", valign: "top" }, text: "" } },
  { text: { text: "Penumbra · DATANOVA 2026 · DN-SU-01", options: { x: 0.6, y: 7.0, w: 8, h: 0.3, fontSize: 10, color: C.accent4, margin: 0 } } },
], slideNumber: { x: 12.2, y: 7.0, w: 0.53, h: 0.3, fontSize: 10, color: C.accent4, align: "right" } });

const chartText = { catAxisLabelFontFace: "+mn-lt", valAxisLabelFontFace: "+mn-lt", dataLabelFontFace: "+mn-lt", legendFontFace: "+mn-lt", titleFontFace: "+mn-lt",
  catAxisLabelColor: C.text1, valAxisLabelColor: C.accent4, catAxisLabelFontSize: 13, valAxisLabelFontSize: 11, dataLabelFontSize: 13, dataLabelColor: C.text1, legendFontSize: 12, legendColor: C.text1,
  valGridLine: { color: HEX.lt2, size: 1 }, catGridLine: { style: "none" } };

function card(s, x, y, w, h, name) { s.addShape(pres.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: C.background2 }, line: { color: C.background2 }, objectName: name }); }
function text(s, t, o) { s.addText(t, { isTextBox: true, margin: 0, valign: "top", color: C.text1, fontSize: 16, ...o }); }
function stat(s, x, y, w, big, small, name) {
  card(s, x, y, w, 1.95, name);
  text(s, big, { x: x + 0.25, y: y + 0.2, w: w - 0.5, h: 0.95, fontSize: 44, bold: true, color: C.accent1, objectName: name + " value" });
  text(s, small, { x: x + 0.25, y: y + 1.15, w: w - 0.5, h: 0.7, fontSize: 14, objectName: name + " label" });
}
function moon(s, x, y, d) {
  s.addShape(pres.ShapeType.ellipse, { x, y, w: d, h: d, fill: { color: C.accent6 }, line: { color: C.accent6 }, objectName: "Mark disc" });
  s.addShape(pres.ShapeType.ellipse, { x: x + d * 0.34, y: y + d * 0.05, w: d * 0.9, h: d * 0.9, fill: { color: C.text2 }, line: { color: C.text2 }, objectName: "Mark shadow" });
}

// 1
pres.addSection({ title: "Overview" });
let s = pres.addSlide({ masterName: "DARK", sectionTitle: "Overview" });
moon(s, 0.8, 1.25, 0.8);
s.addText("Penumbra", { placeholder: "title" });
s.addText("Tomorrow's solar power, with a margin. Calibrated day-ahead forecasts, checked in public against the grid operator.", { placeholder: "body" });
text(s, `DN-SU-01 Solar Energy Generation Forecasting  ·  Yi Yu  ·  ${SITE}`, { x: 0.8, y: 6.5, w: 11.7, h: 0.4, fontSize: 14, color: C.accent5, objectName: "Credits" });
s.addNotes("Penumbra forecasts tomorrow's solar output as a calibrated range, and publishes each forecast next to the official one from Elia, the Belgian grid operator.");

// 2
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Overview" });
s.addText("Solar has to be promised a day before it shines", { placeholder: "title" });
text(s, [
  { text: "A single number hides the decision", options: { bold: true, breakLine: true } },
  { text: "Traders, plant owners and grid operators commit power at 11:00 the day before. They need to know how much they can safely promise.", options: { breakLine: true } },
  { text: "A wide range costs money", options: { bold: true, breakLine: true } },
  { text: "Every megawatt of uncertainty has to be covered by reserves or left unsold.", options: { breakLine: true } },
  { text: "Accuracy claims are hard to check", options: { bold: true, breakLine: true } },
  { text: "We found no forecast vendor that publishes a daily record next to the grid operator's own forecast." },
], { x: 0.6, y: 1.8, w: 6.4, h: 4.8, fontSize: 18, paraSpaceAfter: 10, objectName: "Problem points" });
stat(s, 7.6, 1.8, 5.13, "12.6 GW", "solar monitored by Elia in Belgium, November 2026", "Capacity stat");
stat(s, 7.6, 4.1, 5.13, "1,561 MW", "average width of Elia's 80% band over the 359 test days", "Band stat");
s.addNotes("The benchmark here is strong. Elia's day-ahead forecast is the number the Belgian market already uses.");

// 3
pres.addSection({ title: "Solution" });
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Solution" });
s.addText("Learn where the official forecast goes wrong, then calibrate the range", { placeholder: "title" });
const steps = [["Inputs", "Elia 11:00 forecast and its P10, P90\n4 weather models, 48 h old\nFresh GFS, D-1 00z\nD-1 morning output\nSolar geometry and recent error"],
  ["Residual model", "LightGBM quantile regression learns P10, P50, P90 of the gap to Elia's median. Refit monthly on past data only."],
  ["Calibration", "Rolling conformal shift from the last 60 days, set apart for each width and sun-height bucket, and for national and provincial rows."],
  ["Output", "P10, P50, P90 every 15 minutes, for Belgium and its 11 provinces."]];
steps.forEach(([h, b], i) => {
  const x = 0.6 + i * 3.1;
  card(s, x, 1.9, 2.8, 3.1, `Step ${i + 1}`);
  text(s, h, { x: x + 0.2, y: 2.05, w: 2.4, h: 0.45, fontSize: 18, bold: true, color: C.accent1, objectName: `Step ${i + 1} title` });
  text(s, b, { x: x + 0.2, y: 2.55, w: 2.4, h: 2.35, fontSize: 14, objectName: `Step ${i + 1} text` });
  if (i < 3) s.addShape(pres.ShapeType.rightArrow, { x: x + 2.83, y: 3.3, w: 0.24, h: 0.3, fill: { color: C.accent2 }, line: { color: C.accent2 }, objectName: `Arrow ${i + 1}` });
});
text(s, [{ text: "Second model, for any place on the map: ", options: { bold: true } }, { text: "four 48 h weather models, no local history and no Elia input. It runs inside the browser." }], { x: 0.6, y: 5.4, w: 12.1, h: 0.9, fontSize: 18, objectName: "Second model" });
s.addNotes("We do not re-forecast the weather. We use what the operator already publishes and learn its remaining errors.");

// 4
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Solution" });
s.addText("Every v2 input existed at the 11:00 cutoff", { placeholder: "title" });
const flow = [["History from 2021", "Training start", "Public data only"], ["2025-05 to 2025-10", "Validation", "v2 choices made here"], ["Commit 16e4605", "Freeze", "Pipeline committed before the test"], ["2025-11 to 2026-10", "v2 test, one run", "359 days, chosen on validation"], ["From 2026-11-04", "Live ledger", "Issued before the outcome"]];
s.addShape(pres.ShapeType.line, { x: 1.0, y: 2.25, w: 11.3, h: 0, line: { color: C.accent2, width: 2 }, objectName: "Timeline" });
flow.forEach(([d, h, b], i) => {
  const x = 0.6 + i * 2.45;
  s.addShape(pres.ShapeType.ellipse, { x: x + 0.3, y: 2.08, w: 0.34, h: 0.34, fill: { color: i === 3 ? C.accent3 : C.accent1 }, line: { color: C.background1, width: 2 }, objectName: `Stage ${i + 1} dot` });
  text(s, d, { x, y: 1.65, w: 2.3, h: 0.32, fontSize: 12, color: C.accent4, objectName: `Stage ${i + 1} date` });
  text(s, h, { x, y: 2.6, w: 2.3, h: 0.4, fontSize: 18, bold: true, objectName: `Stage ${i + 1} name` });
  text(s, b, { x, y: 3.02, w: 2.2, h: 0.8, fontSize: 14, objectName: `Stage ${i + 1} text` });
});
card(s, 0.6, 4.2, 12.13, 2.1, "Causality card");
text(s, [
  { text: "Four 48 h weather models, plus fresh GFS 00z of D-1 from the NOAA archive", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "D-1 morning measured output before the cutoff; other output lags stop at D-2", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "Models refit monthly with a 2-day gap; calibration uses outcomes known by D-2", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "Significance: paired daily differences, 2,000 block bootstrap draws", options: { bullet: { indent: 14 } } },
], { x: 0.9, y: 4.42, w: 11.5, h: 2.0, fontSize: 16, paraSpaceAfter: 6, objectName: "Causality points" });
s.addNotes("The test window was used twice: first by v1, then by v2, which was chosen on validation and frozen in 16e4605 before its single run. The first frozen version was v1 (b1ed71c).");

// 5
pres.addSection({ title: "Results" });
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Results" });
s.addText("On 359 test days, v2 improves pinball loss by 10.8% in Belgium", { placeholder: "title" });
s.addChart(pres.ChartType.bar, [
  { name: "Elia day-ahead 11:00", labels: ["Belgium", "11 provinces"], values: [0.0101, 0.0117] },
  { name: "Penumbra v2", labels: ["Belgium", "11 provinces"], values: [0.0090, 0.0105] },
], { x: 0.6, y: 1.7, w: 7.3, h: 4.9, barDir: "col", barGapWidthPct: 70, chartColors: [HEX.accent2, HEX.accent1], showTitle: true, title: "Mean pinball loss: Belgium -10.8%, provinces -10.0%", titleFontSize: 14, titleColor: C.text1, showValue: true, dataLabelFormatCode: "0.0000", dataLabelPosition: "outEnd", showLegend: true, legendPos: "b", valAxisMinVal: 0, valAxisMaxVal: 0.015, valAxisLabelFormatCode: "0.000", altText: "Pinball loss: Elia 0.0101 and Penumbra v2 0.0090 for Belgium; Elia 0.0117 and Penumbra v2 0.0105 for provinces", ...chartText });
stat(s, 8.3, 1.7, 4.43, "10.8% lower", "pinball loss in Belgium; 95% CI of the daily difference excludes zero", "Pinball stat");
stat(s, 8.3, 3.85, 4.43, "9.1%", "average 80% band width in Belgium: 9.1% vs 13.3% of capacity", "Width stat");
text(s, "MAE of the median: 2.79% vs 2.98% in Belgium, 3.28% vs 3.54% in provinces.", { x: 8.3, y: 5.95, w: 4.43, h: 0.7, fontSize: 14, objectName: "MAE note" });
s.addNotes("Paired daily pinball difference: Belgium -0.00106 [-0.00134, -0.00077]; provinces -0.00112 [-0.00135, -0.00090] (95% confidence intervals).");

// 6
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Results" });
s.addText("A narrower band that still covers what it promises", { placeholder: "title" });
s.addChart(pres.ChartType.bar, [
  { name: "Elia day-ahead 11:00", labels: ["Belgium", "11 provinces"], values: [81.9, 75.4] },
  { name: "Penumbra v2", labels: ["Belgium", "11 provinces"], values: [80.2, 80.2] },
], { x: 0.6, y: 1.7, w: 7.3, h: 4.9, barDir: "col", barGapWidthPct: 70, chartColors: [HEX.accent2, HEX.accent1], showTitle: true, title: "Share of outcomes inside the 80% band (%), target 80", titleFontSize: 14, titleColor: C.text1, showValue: true, dataLabelFormatCode: "0.0", dataLabelPosition: "outEnd", showLegend: true, legendPos: "b", valAxisMinVal: 0, valAxisMaxVal: 100, valAxisLabelFormatCode: "0", altText: "Coverage of the 80 percent band: Elia 81.9 and Penumbra 80.2 in Belgium; Elia 75.4 and Penumbra 80.2 in provinces", ...chartText });
text(s, [
  { text: "Why this matters", options: { bold: true, breakLine: true, color: C.accent1, fontSize: 20 } },
  { text: "Elia's band is too wide nationally and too narrow by province. Penumbra lands within half a point of 80% on both.", options: { breakLine: true } },
  { text: "How", options: { bold: true, breakLine: true, color: C.accent1, fontSize: 20 } },
  { text: "National and provincial rows are calibrated apart, on recent errors only, so the band follows the season.", options: { breakLine: true } },
  { text: "Band width", options: { bold: true, breakLine: true, color: C.accent1, fontSize: 20 } },
  { text: "Belgium: 9.1% vs 13.3%. Provinces: 10.5% vs 13.2% of capacity." },
], { x: 8.3, y: 1.8, w: 4.43, h: 4.8, fontSize: 16, paraSpaceAfter: 10, objectName: "Calibration notes" });
s.addNotes("v2 coverage is 80.2% on both scopes. Elia coverage is 81.9% nationally and 75.4% in provinces.");

// 7
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Results" });
s.addText("Far ahead of open source, and it travels to places it has never seen", { placeholder: "title" });
s.addChart(pres.ChartType.bar, [{ name: "MAE, % of capacity", labels: ["Quartz (open source)", "Persistence, D-2", "Penumbra weather only", "Elia day-ahead 11:00", "Penumbra v2"], values: [11.9, 8.97, 4.34, 3.54, 3.28] }],
  { x: 0.6, y: 1.7, w: 7.3, h: 4.9, barDir: "bar", barGapWidthPct: 45, chartColors: [HEX.accent1], showTitle: true, title: "Belgian provinces, 359 test days: MAE (% of capacity)", titleFontSize: 14, titleColor: C.text1, showValue: true, dataLabelFormatCode: "0.00", dataLabelPosition: "outEnd", showLegend: false, valAxisMinVal: 0, valAxisMaxVal: 14, catAxisOrientation: "maxMin", valAxisLabelFormatCode: "0", altText: "MAE: Quartz 11.9, persistence 8.97, Penumbra weather only 4.34, Elia 3.54, Penumbra v2 3.28 percent", ...chartText });
stat(s, 8.3, 1.7, 4.43, "4.14%", "MAE in 3 British regions, with a model trained only on Belgium", "Portability stat");
stat(s, 8.3, 3.85, 4.43, "11.1%", "Quartz on the same British rows and the same 48 h weather", "Quartz stat");
text(s, "Band coverage in Great Britain: 75.4% against the 80% target, with no local calibration data.", { x: 8.3, y: 5.95, w: 4.43, h: 0.7, fontSize: 14, objectName: "Coverage note" });
s.addNotes("Quartz is the strongest open-source baseline we found, MIT licensed, and was given the same archived ICON weather. It is built for single sites and gives no range. Baseline and weather-only scores are from their separately recorded experiments.");

// 8
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Results" });
s.addText("For the Belgian system, the sharper band is worth hundreds of megawatts", { placeholder: "title" });
stat(s, 0.6, 1.8, 3.85, "488 MW", "less average uncertainty to cover: band of 1,073 MW vs 1,561 MW", "Band impact");
stat(s, 4.74, 1.8, 3.85, "+203 MW", "higher average P10: 2,054 MW vs 1,851 MW", "Firm impact");
stat(s, 8.88, 1.8, 3.85, "10.5%", "provincial band width vs 13.2%; coverage rises from 75.4% to 80.2%", "Province impact");
text(s, [
  { text: "Who uses this", options: { bold: true, breakLine: true, color: C.accent1, fontSize: 20 } },
  { text: "Grid operators: size reserves on a band that matches reality", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "Market parties: choose how much to sell, by the risk they accept", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "Plant and home owners: plan batteries and loads for tomorrow", options: { bullet: { indent: 14 }, breakLine: true } },
], { x: 0.6, y: 4.1, w: 7.6, h: 2.5, fontSize: 16, paraSpaceAfter: 6, objectName: "Users" });
card(s, 8.6, 4.1, 4.13, 1.9, "Basis card");
text(s, "Basis: 359 test days, 11.76 GW monitored capacity. Outcomes reached the P10 level 89.9% of the time for Penumbra and 90.4% for Elia.", { x: 8.85, y: 4.3, w: 3.65, h: 1.5, fontSize: 14, objectName: "Basis" });
s.addNotes("MW figures follow src/value.py on 359 v2 test days and median monitored capacity.");

// Accuracy by horizon: generated from the recorded fixed-spec experiment.
const horizonEvidence = require('../site/data/horizons.json');
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Results" });
s.addText("Accuracy by horizon", { placeholder: "title" });
for (const [i, metric, title, factor] of [[0, 'pinball', 'Mean pinball loss', 1], [1, 'width', '80% band width (% of capacity)', 100]]) {
  s.addChart(pres.ChartType.line, ['Belgium', 'Provinces'].map(scope => ({name: scope, labels: ['D+1', 'D+2', 'D+3'], values: horizonEvidence.results.filter(r => r.scope === scope).map(r => r[metric] * factor)})),
    {x: .6 + i * 6.2, y: 1.65, w: 5.9, h: 2.55, chartColors: [HEX.accent1, HEX.accent3], showTitle: true, title, titleFontSize: 14, titleColor: C.text1, showValue: true, dataLabelFormatCode: i ? '0.00' : '0.000000', showLegend: true, legendPos: 'b', showMarker: true, markerSize: 6, ...chartText});
}
s.addTable([horizonEvidence.headers.map(t => ({text:t, options:{bold:true, color:C.background1, fill:{color:C.accent1}}})), ...horizonEvidence.rows], {x:.6, y:4.5, w:12.1, colW:[1.1,2.0,2.3,2.2,2.3,2.2], rowH:.28, margin:2, fontSize:14, color:C.text1, border:{type:'solid', pt:.5, color:HEX.accent5}, objectName:'Horizon results'});
text(s, 'Weather only. 2025-05-01 to 2026-10-31. Elia D+1 reference only: ' + horizonEvidence.elia.map(r => `${r.scope} pinball ${r.pinball.toFixed(6)}, width ${(r.width*100).toFixed(2)}%`).join('; '), {x:.6, y:6.55, w:12.1, h:.35, fontSize:12, color:C.accent4, objectName:"Horizon reference"});
s.addNotes(horizonEvidence.note + '\n' + horizonEvidence.rows.map(r => r.join(' | ')).join('\n'));

// 9
pres.addSection({ title: "Product" });
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Product" });
s.addText("A working forecast in under 15 seconds, with no sign-up", { placeholder: "title" });
s.addImage({ path: "deck/img/tool_panel.png", x: 0.6, y: 1.7, w: 7.6, h: 4.67, altText: "Penumbra forecast tool showing Cambridge with a P10 to P90 band", objectName: "Tool screenshot" });
text(s, [
  { text: "Any place: search, GPS or coordinates", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "Model runs in the browser; coordinates go only to the weather API", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "Risk slider turns the band into a commitment", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "CSV and JSON export, shareable links", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "Works at phone width", options: { bullet: { indent: 14 }, breakLine: true } },
  { text: "Browser results match Python to 0.0001 on real weather, tested on every change", options: { bullet: { indent: 14 } } },
], { x: 8.6, y: 1.8, w: 4.13, h: 4.2, fontSize: 16, paraSpaceAfter: 8, objectName: "Product features" });
text(s, SITE, { x: 8.6, y: 6.05, w: 4.13, h: 0.35, fontSize: 14, bold: true, color: C.accent1, objectName: "Link" });
s.addNotes("Open the site, search for a place, move the slider. Assumes a typical fleet mix; tilt and orientation are not modelled in this version.");

// 10
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Product" });
s.addText("Every forecast goes on a public ledger, next to Elia's", { placeholder: "title" });
s.addImage({ path: "deck/img/ledger_chart.png", x: 0.6, y: 1.7, w: 7.6, h: 3.27, altText: "Ledger chart comparing Penumbra and Elia for Belgium on 3 November 2026", objectName: "Ledger screenshot" });
text(s, "Each morning after Elia's 11:00 forecast, Penumbra issues tomorrow's forecast. The next day it is scored automatically.", { x: 0.6, y: 5.2, w: 7.6, h: 1.3, fontSize: 16, objectName: "Ledger caption" });
text(s, [
  { text: "Never edited: ", options: { bold: true } }, { text: "each file holds the hash of the one before, and your browser checks the chain", options: { breakLine: true } },
  { text: "Time-stamped: ", options: { bold: true } }, { text: "public Git history dates every entry", options: { breakLine: true } },
  { text: "Honest labels: ", options: { bold: true } }, { text: "live days and backfilled days are scored apart and never added together" },
], { x: 8.6, y: 1.8, w: 4.13, h: 4.6, fontSize: 16, paraSpaceAfter: 14, objectName: "Ledger points" });
s.addNotes("Live forecasts start on 4 November 2026. Elia published no 11:00 forecast for 28 October, after moving to new datasets, so that date has no entry.");

// 11
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Product" });
s.addText("Compared with the products people use today", { placeholder: "title" });
const head = (t) => ({ text: t, options: { bold: true, color: C.background1, fill: { color: C.accent1 } } });
const yes = { color: C.accent1, bold: true };
const row = (a, ...r) => [{ text: a, options: { bold: true } }, ...r.map((t) => ({ text: t, options: t === "Yes" ? yes : {} }))];
s.addTable([
  [head(""), head("Solcast"), head("Forecast.Solar"), head("Sprixin"), head("Quartz"), head("Penumbra")],
  row("Forecast with no sign-up", "No", "API only", "No", "Install", "Yes"),
  row("P10, P50, P90 range", "Yes", "Not listed", "Not listed", "No", "Yes"),
  row("Measured coverage published", "Not listed", "Not listed", "Not listed", "No", "Yes"),
  row("Daily record against the grid operator", "Not listed", "No", "Not listed", "No", "Yes"),
  row("Risk-based commitment", "Not listed", "No", "Not listed", "No", "Yes"),
  row("Tilt and orientation", "Yes", "Yes", "Yes", "Yes", "Next version"),
], { x: 0.6, y: 1.8, w: 12.13, colW: [4.13, 1.6, 1.6, 1.6, 1.6, 1.6], rowH: 0.62, fontSize: 14, color: C.text1, border: { type: "solid", pt: 0.5, color: HEX.accent5 }, valign: "middle", objectName: "Competitor table" });
text(s, "Based on each product's public pages and documentation, November 2026. \"Not listed\" means we did not find it there.", { x: 0.6, y: 6.2, w: 12.1, h: 0.5, fontSize: 12, color: C.accent4, objectName: "Table note" });
s.addNotes("Solcast is the international commercial standard, Forecast.Solar is common among home users and developers, Sprixin is the listed Chinese market leader, Quartz is the open-source baseline.");

// 12
pres.addSection({ title: "Build" });
s = pres.addSlide({ masterName: "CONTENT", sectionTitle: "Build" });
s.addText("Tech stack, sources and contributions", { placeholder: "title" });
const cols = [["Tech stack", ["Python, pandas, LightGBM", "Rolling conformal quantile calibration", "Static site, plain JavaScript, uPlot", "Trees exported to JSON for browser inference", "Scheduled daily ledger job"]],
  ["Third-party data and code", ["Elia Open Data: solar, imbalance prices", "Open-Meteo Previous Runs, CC BY 4.0", "NOAA GFS archive, fresh D-1 00z", "Sheffield Solar PV_Live: GB outturn", "Energy-Charts: day-ahead prices", "Quartz Solar Forecast (MIT), baseline only", "uPlot (MIT)"]],
  ["Team and reproducibility", ["Yi Yu: problem framing, data, modelling, validation, product, deck", "AI coding assistants helped write and check code", "Results reproducible from the public repository", "Experiment log: EXPERIMENTS.md"]]];
cols.forEach(([h, items], i) => {
  const x = 0.6 + i * 4.14;
  card(s, x, 1.7, 3.85, 4.9, `${h} card`);
  text(s, h, { x: x + 0.25, y: 1.9, w: 3.35, h: 0.75, fontSize: 18, bold: true, color: C.accent1, objectName: `${h} title` });
  text(s, items.map((t, j) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: j < items.length - 1 } })), { x: x + 0.25, y: 2.7, w: 3.35, h: 3.75, fontSize: 14, paraSpaceAfter: 6, objectName: `${h} list` });
});
s.addNotes("Full licences and attribution are on the site's method page and in the README.");

// 13
s = pres.addSlide({ masterName: "DARK", sectionTitle: "Build" });
moon(s, 0.8, 1.25, 0.8);
s.addText("Try tomorrow", { placeholder: "title" });
s.addText("v2: 10.8% lower Belgian pinball loss. 80.2% coverage. A record anyone can check.", { placeholder: "body" });
text(s, SITE, { x: 0.8, y: 5.1, w: 11.7, h: 0.5, fontSize: 24, bold: true, color: C.background1, objectName: "Site link" });
text(s, "Next: plant tilt and orientation, alerts and an API, more countries on the ledger.", { x: 0.8, y: 6.5, w: 11.7, h: 0.4, fontSize: 14, color: C.accent5, objectName: "Next steps" });
s.addNotes("Thank you. The ledger keeps running through judging.");


}
module.exports = {THEME, buildContent};
