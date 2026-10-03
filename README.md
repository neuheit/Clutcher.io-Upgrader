# Clutcher.io Upgrader

An upgrader (upgrader.pro style) for clutcher.io using your real skins and coins. Client-side only.

## Install (players)
1. Install the Tampermonkey extension.
2. Open this link and click **Install**:
   `https://raw.githubusercontent.com/neuheit/Clutcher.io-Upgrader/main/clutcher-upgrader.user.js`
3. Open clutcher.io. An **UPGRADER** tab appears in the top bar.

Updates arrive automatically (Tampermonkey checks the same link).

## Publish (you)
1. Create a **public** GitHub repo and upload everything in this folder, including `.github/workflows/prices.yml`.
2. In the files below, replace `neuheit/Clutcher.io-Upgrader` with your repo path (`clutcher-upgrader.user.js` has 3 spots: `@updateURL`, `@downloadURL`, `PRICES_URL`).
3. Repo **Settings > Actions > General > Workflow permissions**: choose *Read and write permissions*.
4. **Actions tab > Update prices > Run workflow** once. It fills `prices.json`, then refreshes daily on its own.
5. Share the raw link from "Install" above.

## Releasing a new version
Edit `clutcher-upgrader.user.js`, **raise `@version`** (e.g. 3.7.0 -> 3.7.1), commit. Tampermonkey only updates users when that number goes up.

## Notes
- Prices are Skinport USD market prices (all wears, Doppler phases). Manual overrides are in the `OVERRIDES` table in the script.
- Coins convert at `COINS_PER_USD` (top of the script).
- Back up your save before using any mod: run `copy(localStorage.clutcher_inv_v1)` in the console and paste it into a text file.
