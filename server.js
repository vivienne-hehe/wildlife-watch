// server.js
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const exifr = require("exifr");
const { analyzeImage } = require("./services/vision");

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_FILE = path.join(__dirname, "data", "records.json");

// ---------- Simple JSON-file "database" ----------
function readRecords() {
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function writeRecords(records) {
  fs.writeFileSync(DB_FILE, JSON.stringify(records, null, 2));
}

// ---------- File upload settings ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    cb(null, /image\/(jpeg|png|webp)/.test(file.mimetype));
  },
});

// ---------- Alert rules (the team's own logic goes here) ----------
function decideAlert(ai) {
  // Rule 1: a person or vehicle in the frame → raise an alert
  if (ai.has_human || ai.has_vehicle) return { alert: true, reason: "Person or vehicle detected" };
  // Rule 2: a night image with an animal the model is unsure about → flag for human review (example rule; extend as needed)
  if (ai.is_night && ai.species !== "none" && ai.confidence < 0.6) {
    return { alert: false, reason: "Low-confidence night sighting — needs human review" };
  }
  return { alert: false, reason: "" };
}

// Public view: round coordinates to 0.1° (~10 km grid) so exact locations are not exposed
function blur(value) {
  return Math.round(value * 10) / 10;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

// ---------- Upload + AI analysis ----------
app.post("/api/upload", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image received, or the file type is not supported" });

    // 1. Try to read GPS position and capture time from EXIF
    let lat = null, lng = null, time = null;
    try {
      const exif = await exifr.parse(req.file.path, { gps: true, pick: ["DateTimeOriginal"] });
      if (exif?.latitude && exif?.longitude) {
        lat = exif.latitude;
        lng = exif.longitude;
      }
      if (exif?.DateTimeOriginal) time = new Date(exif.DateTimeOriginal).toISOString();
    } catch (_) {}

    // 2. Coordinates typed into the form take priority (public dataset images usually have no GPS)
    if (req.body.lat && req.body.lng) {
      lat = parseFloat(req.body.lat);
      lng = parseFloat(req.body.lng);
    }
    if (lat == null || lng == null) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "This photo has no GPS data. Enter the latitude and longitude manually." });
    }
    if (!time) time = new Date().toISOString();

    // 3. Run AI analysis
    const ai = await analyzeImage(req.file.path);
    const { alert, reason } = decideAlert(ai);

    // 4. Save the record
    const records = readRecords();
    const record = {
      id: Date.now(),
      imageUrl: `/uploads/${req.file.filename}`,
      lat, lng, time,
      camera: req.body.camera || "Unnamed camera",
      ...ai,
      alert,
      alertReason: reason,
    };
    records.push(record);
    writeRecords(records);

    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Query records (?view=public returns fuzzed coordinates) ----------
app.get("/api/records", (req, res) => {
  let records = readRecords();
  if (req.query.species) records = records.filter((r) => r.species === req.query.species);
  if (req.query.view === "public") {
    records = records.map((r) => ({ ...r, lat: blur(r.lat), lng: blur(r.lng), imageUrl: null }));
  }
  res.json(records);
});

// ---------- Simple stats: sightings per species ----------
app.get("/api/stats", (req, res) => {
  const records = readRecords();
  const bySpecies = {};
  for (const r of records) bySpecies[r.species] = (bySpecies[r.species] || 0) + 1;
  res.json({
    total: records.length,
    alerts: records.filter((r) => r.alert).length,
    bySpecies,
  });
});

// ---------- Delete a record (handy for cleaning up during demos) ----------
app.delete("/api/records/:id", (req, res) => {
  const records = readRecords();
  const idx = records.findIndex((r) => String(r.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Record not found" });
  const [removed] = records.splice(idx, 1);
  writeRecords(records);
  const filePath = path.join(__dirname, removed.imageUrl);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Wildlife Watch running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.warn("⚠ GEMINI_API_KEY is not set; image analysis will fail");
});
