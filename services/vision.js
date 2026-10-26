// services/vision.js
// Sends one photo to a multimodal AI model and asks for structured JSON back.
// This is where to edit the prompts, switch models, or set up comparison experiments.

const fs = require("fs");

// Gemini API (REST). Node 18+ has fetch built in, so no SDK is needed.
const MODEL = process.env.VISION_MODEL || "gemini-3.8-flash";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Target species. Anything else should be returned as "other".
// Names match testset/labels.csv (Snapshot Serengeti naming).
const SPECIES = ["buffalo", "gazellegrants", "gazellethomsons", "giraffe", "hartebeest", "hyenaspotted", "warthog", "zebra", "none"];

// Prompt variants. Set PROMPT_VARIANT=minimal or PROMPT_VARIANT=improved to switch, for the evaluation comparison.

// Minimal prompt: output format only, no guidance.
const PROMPT_MINIMAL = `Analyze this camera-trap photo. Return JSON only:
{"species": "${SPECIES.join(" | ")} | other", "count": integer, "confidence": 0 to 1, "has_human": true/false, "has_vehicle": true/false, "is_night": true/false, "note": "one short sentence"}`;

// Full prompt: role, field definitions, species descriptions, and rules.
const PROMPT_FULL = `You are a camera-trap photo analysis assistant for a wildlife reserve.
Analyze this photo and return a single JSON object only — no explanation and no markdown code fences.

JSON format:
{
  "species": "${SPECIES.join(" | ")} | other",
  "count": number of animals (integer; 0 if there are no animals),
  "confidence": a number from 0 to 1 for how sure you are about the species,
  "has_human": true/false (is there a person in the frame),
  "has_vehicle": true/false (is there a vehicle in the frame),
  "is_night": true/false (is this a night / infrared image),
  "note": "one-sentence description of the scene, 12 words or fewer"
}

Species notes:
- gazellegrants = Grant's gazelle: larger; the white rump patch extends above the tail.
- gazellethomsons = Thomson's gazelle: smaller; a bold black stripe along the flank.
- hartebeest = hartebeest (Coke's hartebeest): tan antelope with a long face and bracket-shaped horns.
- hyenaspotted = spotted hyena.

Rules:
- If there is no animal (only vegetation or an empty scene), set species to "none".
- If a person or vehicle is present, always set has_human / has_vehicle to true, even if there is also an animal.
- If you are unsure, lower the confidence rather than guessing.`;

// Improved prompt: the full prompt plus extra rules for partly visible animals,
// edge/far-away animals, and Grant's vs Thomson's gazelles.
const PROMPT_IMPROVED_FULL = `You are a camera-trap photo analysis assistant for a wildlife reserve.
Analyze this photo and return a single JSON object only — no explanation and no markdown code fences.

JSON format:
{
  "species": "${SPECIES.join(" | ")} | other",
  "count": number of animals (integer; 0 if there are no animals),
  "confidence": a number from 0 to 1 for how sure you are about the species,
  "has_human": true/false (is there a person in the frame),
  "has_vehicle": true/false (is there a vehicle in the frame),
  "is_night": true/false (is this a night / infrared image),
  "note": "one-sentence description of the scene, 12 words or fewer"
}

Species notes:
- gazellegrants = Grant's gazelle: larger; the white rump patch extends above the tail.
- gazellethomsons = Thomson's gazelle: smaller; a bold black stripe along the flank.
- hartebeest = hartebeest (Coke's hartebeest): tan antelope with a long face and bracket-shaped horns.
- hyenaspotted = spotted hyena.

Rules:
- If there is no animal (only vegetation or an empty scene), set species to "none".
- If a person or vehicle is present, always set has_human / has_vehicle to true, even if there is also an animal.
- If you are unsure, lower the confidence rather than guessing.
- Check the full frame, including the edges, for small or far-away animals.
- Do not ignore an animal just because it is only partly visible or hard to see. If you can make out its outline, count it as an animal rather than treating it as background or vegetation. For example, a black-hided animal against a yellow background with only a small part showing is still an animal.
- If an animal is partly hidden but its outline is still clear, report it as the animal it appears to be.
- To tell Grant's gazelle from Thomson's gazelle, look at the flank stripe together with size and the rump patch. A faint or absent stripe points to gazellegrants; a bold black stripe points to gazellethomsons. If the animal is too small, far away or blurry to judge the stripe, do not default to gazellegrants: pick the more likely species and lower the confidence.`;

const PROMPTS = { minimal: PROMPT_MINIMAL, improved: PROMPT_IMPROVED_FULL };
const PROMPT = PROMPTS[process.env.PROMPT_VARIANT] || PROMPT_FULL;

function mediaTypeOf(filePath) {
  const ext = filePath.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// The free tier allows only 15 requests per minute (429), and the model is sometimes
// overloaded (503). Both are temporary, so wait and retry instead of failing the image.
const RETRY_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, options) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (!RETRY_STATUSES.has(res.status) || attempt >= MAX_RETRIES) return res;

    // A 429 body says "Please retry in 7.74s"; otherwise back off 5s, 10s, 15s...
    const errText = await res.clone().text();
    const hinted = /retry in ([\d.]+)s/i.exec(errText);
    const waitMs = hinted ? Math.ceil(Number(hinted[1]) * 1000) + 1000 : 5000 * (attempt + 1);
    console.warn(`  (Gemini ${res.status}, retrying in ${Math.round(waitMs / 1000)}s, attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(waitMs);
  }
}

async function analyzeImage(filePath) {
  const imageBase64 = fs.readFileSync(filePath).toString("base64");

  const res = await fetchWithRetry(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mediaTypeOf(filePath), data: imageBase64 } },
            { text: PROMPT },
          ],
        },
      ],
      // Ask Gemini to return raw JSON, which reduces parsing failures
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API returned ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || "").join("\n");
  if (!text) throw new Error("Gemini returned no content (possibly blocked by the safety filter): " + JSON.stringify(data.promptFeedback || {}));

  // Models sometimes wrap the JSON in ```json ... ``` — strip that before parsing
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  // Normalise field types so the rest of the app never receives bad values
  return {
    species: SPECIES.includes(parsed.species) ? parsed.species : "other",
    count: Number(parsed.count) || 0,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    has_human: Boolean(parsed.has_human),
    has_vehicle: Boolean(parsed.has_vehicle),
    is_night: Boolean(parsed.is_night),
    note: String(parsed.note || ""),
  };
}

module.exports = { analyzeImage, SPECIES, MODEL };
