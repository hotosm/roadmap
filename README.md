# Public Roadmap

Static roadmap prototype based on the product brief in `plan.md`.

## Files

- `index.html`: page structure
- `styles.css`: HOT-inspired visual system and responsive layout
- `script.js`: frontend renderer that reads static roadmap data from `data/data.json`
- `scripts/generate.js`: Linear data exporter --> `data/data.json` file

## Customize

The site now reads a pre-generated JSON file instead of hitting Linear from the browser.

Each roadmap item in the JSON feed contains:

- `id`
- `title`
- `group`
- `summary`
- `owner`
- `status`
- `startDate`
- `targetDate`
- `issues`

Each `issues` entry contains open Linear issue metadata and GitHub attachment links needed by the detail panel.

## Generate data

Create a `.env` file in the repo root containing:

```bash
LINEAR_API_KEY=your_token_here
```

Then run:

```bash
node scripts/generate.js
```

That writes [data/data.json](/sam/repos/roadmap/data/data.json), which the frontend loads at runtime.

## Run

- Run the generator first so `data/data.json` exists.
- Then simply open `index.html` to view the site.
- Or run a basic websever:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` on the host machine, or the forwarded port URL from your dev environment.

## GitHub Actions

The repo includes two workflows:

- [.github/workflows/deploy-pages.yml](/sam/repos/roadmap/.github/workflows/deploy-pages.yml): publishes the static site to GitHub Pages on every push to `main`
- [.github/workflows/refresh-data.yml](/sam/repos/roadmap/.github/workflows/refresh-data.yml): runs weekly, regenerates `data/data.json`, commits it, and lets that push trigger a republish

Set the repository secret `LINEAR_API_KEY` in GitHub before enabling the scheduled refresh workflow.
