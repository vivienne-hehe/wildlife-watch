// scripts/evaluate.js
// Usage: node scripts/evaluate.js testset/labels.csv testset/images [variant-name]
//
// labels.csv columns (header names are case-insensitive):
//   filename, species, count, has_human, has_vehicle, is_night
//   e.g. zebra_day_01.jpg, zebra, 2, false, false, false
//
// Output:
//   results/<variant>-results.csv   our label vs. the model output, one row per image
//   results/<variant>-report.md     metrics summary (can be pasted into the project report)

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { analyzeImage, SPECIES, MODEL } = require("../services/vision");

const [, , labelsPath, imagesDir, variant = "baseline"] = process.argv;
if (!labelsPath || !imagesDir) {
  console.error("Usage: node scripts/evaluate.js <labels.csv> <images-folder> [variant-name]");
  process.exit(1);
}

// ---------- Read labels ----------
// Accepts comma- or tab-separated files, headers with spaces such as "File Name" / "True Species" / "Has Human", and Yes/No values.
// If the species cell is empty or "Yes", the species is taken from the file name before the first underscore (buffalo_day_01.jpg → buffalo).
const HEADER_ALIASES = {
  filename: ["filename", "file", "filename", "image", "photo"],
  species: ["species", "truespecies", "label", "animal"],
  count: ["count", "number", "num"],
  has_human: ["hashuman", "human", "person", "hasperson"],
  has_vehicle: ["hasvehicle", "vehicle", "car"],
  is_night: ["isnight", "night", "infrared"],
};
function normHeader(h) {
  const key = h.trim().toLowerCase().replace(/[\s_\-]/g, "");
  for (const [std, aliases] of Object.entries(HEADER_ALIASES)) if (aliases.includes(key)) return std;
  return key;
}
function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(delim).map(normHeader);
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const cells = line.split(delim).map((c) => c.trim());
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}
const bool = (v) => /^(true|1|yes|y)$/i.test(String(v).trim());
const KNOWN = new Set([...SPECIES, "other"]);
function speciesOf(row) {
  let sp = String(row.species || "").trim().toLowerCase();
  if (!sp || /^(yes|y|true)$/.test(sp)) sp = String(row.filename).split(/[_\-\s.]/)[0].toLowerCase();
  if (row.has_human !== undefined && bool(row.has_human) && (sp === "human" || sp === "person")) sp = "none";
  if (sp === "empty" || sp === "blank") sp = "none";
  return sp;
}

const rawRows = parseCSV(fs.readFileSync(labelsPath, "utf8"));
if (!rawRows.length || !("filename" in rawRows[0])) {
  console.error("The label file has no file-name column. The header must include filename or File Name.");
  process.exit(1);
}
const labels = rawRows.map((r) => ({
  filename: r.filename,
  species: speciesOf(r),
  count: Number(r.count) || 0,
  has_human: bool(r.has_human),
  has_vehicle: bool(r.has_vehicle),
  is_night: bool(r.is_night),
}));
const unknown = [...new Set(labels.map((l) => l.species).filter((sp) => !KNOWN.has(sp)))];
if (unknown.length) {
  console.warn(`⚠ These species are not in the SPECIES list in vision.js and will be scored as "other": ${unknown.join(", ")}`);
  console.warn("  If they are target species, add them to the SPECIES array in services/vision.js.\n");
}

// ---------- Call the model for each image ----------
async function run() {
  const results = [];
  for (let i = 0; i < labels.length; i++) {
    const gt = labels[i];
    const file = path.join(imagesDir, gt.filename);
    process.stdout.write(`[${i + 1}/${labels.length}] ${gt.filename} ... `);
    try {
      const pred = await analyzeImage(file);
      results.push({ ...gt, pred, error: "" });
      console.log(`${pred.species} (${pred.confidence})`);
    } catch (err) {
      results.push({ ...gt, pred: null, error: err.message });
      console.log("FAILED:", err.message);
    }
  }
  return results;
}

// ---------- Metrics ----------
function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "n/a";
}

function buildReport(results) {
  const ok = results.filter((r) => r.pred);
  const lines = [];
  lines.push(`# Evaluation report — ${variant}`);
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)} | Model: ${MODEL} | Prompt: ${process.env.PROMPT_VARIANT || "full"} | Images: ${results.length} (succeeded ${ok.length}, failed ${results.length - ok.length})`);
  lines.push("");

  // 1. Species accuracy
  const correct = ok.filter((r) => r.pred.species === r.species);
  lines.push("## 1. Species accuracy");
  lines.push(`Overall: **${pct(correct.length, ok.length)}** (${correct.length}/${ok.length})`);
  lines.push("");
  lines.push("| Species | Images | Correct | Accuracy |");
  lines.push("|---|---|---|---|");
  const allSpecies = [...new Set([...SPECIES, "other", ...ok.map((r) => r.species)])];
  for (const sp of allSpecies) {
    const rows = ok.filter((r) => r.species === sp);
    if (!rows.length) continue;
    const c = rows.filter((r) => r.pred.species === sp).length;
    lines.push(`| ${sp} | ${rows.length} | ${c} | ${pct(c, rows.length)} |`);
  }
  lines.push("");

  // 2. Confusion matrix
  lines.push("## 2. Confusion matrix (rows = true label, columns = model prediction)");
  const present = allSpecies.filter((sp) => ok.some((r) => r.species === sp || r.pred.species === sp));
  lines.push("| True \\ Predicted | " + present.join(" | ") + " |");
  lines.push("|---|" + present.map(() => "---").join("|") + "|");
  for (const row of present) {
    const cells = present.map((col) => ok.filter((r) => r.species === row && r.pred.species === col).length);
    if (cells.every((c) => c === 0) && !ok.some((r) => r.species === row)) continue;
    lines.push(`| **${row}** | ${cells.join(" | ")} |`);
  }
  lines.push("");

  // 3. Human / vehicle detection
  function detectionStats(field) {
    const tp = ok.filter((r) => r[field] && r.pred[field]).length;
    const fp = ok.filter((r) => !r[field] && r.pred[field]).length;
    const fn = ok.filter((r) => r[field] && !r.pred[field]).length;
    const tn = ok.filter((r) => !r[field] && !r.pred[field]).length;
    return { tp, fp, fn, tn, precision: pct(tp, tp + fp), recall: pct(tp, tp + fn), fpRate: pct(fp, fp + tn) };
  }
  lines.push("## 3. Human / vehicle detection (poaching indicators)");
  lines.push("| Target | True pos. (TP) | False pos. (FP) | Missed (FN) | Precision | Recall | False-positive rate |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const [name, field] of [["Human", "has_human"], ["Vehicle", "has_vehicle"]]) {
    const s = detectionStats(field);
    lines.push(`| ${name} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.precision} | ${s.recall} | ${s.fpRate} |`);
  }
  lines.push("");
  lines.push("Precision = share of alerts that really contain a person/vehicle. Recall = share of images with a person/vehicle that were caught. False-positive rate = share of images without a person/vehicle that were wrongly flagged. For anti-poaching, **misses** (low recall) are more dangerous than false alarms.");
  lines.push("");

  // 4. Day vs. night
  lines.push("## 4. Day vs. night");
  lines.push("| Condition | Images | Species accuracy |");
  lines.push("|---|---|---|");
  for (const [name, night] of [["Day", false], ["Night / infrared", true]]) {
    const rows = ok.filter((r) => r.is_night === night);
    const c = rows.filter((r) => r.pred.species === r.species).length;
    lines.push(`| ${name} | ${rows.length} | ${pct(c, rows.length)} |`);
  }
  lines.push("");

  // 5. Confidence thresholds
  lines.push("## 5. Confidence threshold analysis");
  lines.push("If only results with confidence ≥ threshold are auto-accepted (no human review), how much is covered and how accurate is it:");
  lines.push("");
  lines.push("| Threshold | Share auto-accepted | Accuracy of auto-accepted |");
  lines.push("|---|---|---|");
  for (const th of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
    const rows = ok.filter((r) => r.pred.confidence >= th);
    const c = rows.filter((r) => r.pred.species === r.species).length;
    lines.push(`| ≥ ${th} | ${pct(rows.length, ok.length)} | ${pct(c, rows.length)} |`);
  }
  lines.push("");
  lines.push("The PRD §2 target is \"> 70% auto-accepted at ≥ 0.9 confidence\". Use the table above to judge whether that threshold is realistic.");
  lines.push("");

  // 6. Count
  const withAnimals = ok.filter((r) => r.count > 0);
  const countExact = withAnimals.filter((r) => r.pred.count === r.count).length;
  lines.push("## 6. Animal count");
  lines.push(`Images with animals where the count is exactly right: ${pct(countExact, withAnimals.length)} (${countExact}/${withAnimals.length})`);
  lines.push("");

  // 7. Error cases
  lines.push("## 7. Error cases (for the report)");
  const wrong = ok.filter((r) => r.pred.species !== r.species || r.has_human !== r.pred.has_human || r.has_vehicle !== r.pred.has_vehicle);
  lines.push(`${wrong.length} images had at least one error. Pick the 5 most typical, show them in the report, and explain why the model got them wrong.`);
  lines.push("");
  lines.push("| File | True | Predicted | Confidence | Human (true/pred) | Vehicle (true/pred) | Model note |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of wrong) {
    lines.push(`| ${r.filename} | ${r.species} | ${r.pred.species} | ${r.pred.confidence} | ${r.has_human}/${r.pred.has_human} | ${r.has_vehicle}/${r.pred.has_vehicle} | ${r.pred.note} |`);
  }
  if (results.some((r) => r.error)) {
    lines.push("");
    lines.push("## Failed API calls");
    results.filter((r) => r.error).forEach((r) => lines.push(`- ${r.filename}: ${r.error}`));
  }
  return lines.join("\n");
}

function toCSV(results) {
  const head = "filename,gt_species,gt_count,gt_human,gt_vehicle,gt_night,pred_species,pred_count,pred_confidence,pred_human,pred_vehicle,pred_night,species_correct,note,error";
  const rows = results.map((r) => {
    const p = r.pred || {};
    const note = String(p.note || "").replace(/,/g, ";");
    return [r.filename, r.species, r.count, r.has_human, r.has_vehicle, r.is_night,
      p.species ?? "", p.count ?? "", p.confidence ?? "", p.has_human ?? "", p.has_vehicle ?? "", p.is_night ?? "",
      r.pred ? r.pred.species === r.species : "", note, r.error].join(",");
  });
  return [head, ...rows].join("\n");
}

run().then((results) => {
  const outDir = path.join(__dirname, "..", "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${variant}-results.csv`), toCSV(results));
  const report = buildReport(results);
  fs.writeFileSync(path.join(outDir, `${variant}-report.md`), report);
  console.log("\n" + report.split("\n").slice(0, 12).join("\n"));
  console.log(`\nFull report: results/${variant}-report.md`);
});
