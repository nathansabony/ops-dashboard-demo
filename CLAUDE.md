# Working on this repo

This is the **Cedar Ridge Management demo**: a standalone showcase that runs entirely on
fictional data (`DEMO_MODE=1`, fake Rent Manager in `services/demo/`). It is not connected
to any real company, system or deploy pipeline.

- Run it with `npm install && npm start` (port 3001, or `PORT=...`). `scripts/demoServer.js`
  forces `DEMO_MODE=1` and blanks any Rent Manager credentials.
- Run the checks listed in `.github/workflows/checks.yml` locally before committing.
- Keep all data fictional: the world is in `services/demo/world.js` (entity "Cedar Ridge",
  five Columbus, OH properties, four staff). Do not add real names, addresses or figures.
