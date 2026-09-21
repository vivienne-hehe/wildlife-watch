# Wildlife Watch — Camera-trap AI analysis and sighting map

WAICY project prototype: upload a camera-trap photo → a multimodal AI model (Gemini) identifies the species and checks for people or vehicles → the sighting is saved → it appears on a Leaflet map, with alerts for people and vehicles.

## Quick start

```bash
npm install
cp .env.example .env      # then add your GEMINI_API_KEY
npm run dev               # or: npm start
```

Open http://localhost:3000

You need Node.js 18 or newer. Get a Gemini API key from Google AI Studio (https://aistudio.google.com/apikey).

## Project structure

```
server.js              Express backend: upload, AI analysis, storage, queries, stats
services/vision.js     Calls the Gemini API and returns structured JSON (prompts live here)
scripts/evaluate.js    Runs the labelled test set through the model and computes metrics
public/index.html      Frontend: upload form, stats panel, Leaflet map
data/records.json      JSON-file "database"
uploads/               Uploaded photos
testset/               Test-set labels (labels.csv) and images (images/)
results/               Evaluation output (created when you run the evaluation)
```

## API endpoints

| Method | Path | Description |
|---|---|---|
| POST | /api/upload | Form fields: photo (file), camera, lat, lng. Returns the analysis result |
| GET | /api/records | List sightings. `?species=zebra` filters by species; `?view=public` fuzzes coordinates and hides photos |
| GET | /api/stats | Total sightings, number of alerts, sightings per species |
| DELETE | /api/records/:id | Delete one sighting |

## Evaluation (labelled test set)

```bash
# 1. Put the images in testset/images/ and the labels in testset/labels.csv
#    (see testset/labels.example.csv for the format)
# 2. Run the baseline (full prompt)
node scripts/evaluate.js testset/labels.csv testset/images baseline
# 3. Run the minimal prompt for comparison
PROMPT_VARIANT=minimal node scripts/evaluate.js testset/labels.csv testset/images minimal
```

On Windows PowerShell, use `$env:PROMPT_VARIANT="minimal"; node scripts/evaluate.js ...` for step 3.

Results are written to `results/<variant>-report.md` (metrics summary, ready to paste into the report) and `results/<variant>-results.csv` (one row per image).

## Where the team's own work goes

- **Prompt experiments** — `PROMPT_FULL` and `PROMPT_MINIMAL` in `services/vision.js`. Try adding few-shot examples or changing the species descriptions, then compare accuracy on the same test set.
- **Alert rules** — `decideAlert()` in `server.js`. Currently: any person or vehicle raises an alert, and low-confidence night sightings are flagged for review. Ideas: only alert when the same camera sees a person in several frames in a row.
- **Location privacy** — `blur()` in `server.js`. The public view rounds coordinates to 0.1° (~10 km). The PRD specifies a random offset computed once at upload and stored; implementing that is a good next step.
- **Frontend** — heat map (leaflet.heat), date filter, a list of open alerts.
- **Model comparison** — change `VISION_MODEL` in `.env` and rerun the evaluation to compare models.

## Test data

- Animal images: Snapshot Serengeti (LILA BC, https://lila.science/datasets/snapshot-serengeti)
- Human images: Seattle(ish) Camera Traps (LILA BC, https://lila.science/datasets/seattleish-camera-traps/). Public camera-trap datasets remove images of people for privacy; this dataset contains only its author, who released the images with consent. License: CDLA-Permissive-1.0.
- Vehicle images: taken by the team.

Public dataset images usually have no GPS data, so for demos enter latitude and longitude in the upload form, or give each camera ID a fixed location.

## Honesty statement

This project uses a pre-trained multimodal model and does not train or fine-tune one. The team's AI work is the prompt design, structured-output parsing, confidence-threshold logic, alert rules, the evaluation on a labelled test set, and the privacy design.
