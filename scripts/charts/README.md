# Charts

`build_charts.py` regenerates every chart in [`docs/media/charts/`](../../docs/media/charts/) from committed data. Each chart is written four times: light and dark, SVG and PNG at 2x. The README shows the SVGs through `<picture>`, so GitHub picks the variant that matches the reader's theme; the PNGs are for slides and the video.

## Rebuild

```bash
python3 scripts/charts/build_charts.py              # every chart
python3 scripts/charts/build_charts.py gas epoch    # some: tests, coverage, gas, backtest, epoch, matrix, positioning
```

Needs Python 3 with matplotlib (3.10 was used). Output is deterministic (`svg.hashsalt` is fixed and dates are stripped), so an unchanged input gives an unchanged SVG.

## Charts and their data

| Chart                               | File                        | Data                                                                                                                                              | How to refresh the data                                                                                                                                                                          |
| ----------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tests by suite                      | `tests-by-suite-*`          | [`data/forge-tests.txt`](data/forge-tests.txt), [`data/tests.json`](data/tests.json)                                                              | `cd contracts && forge test --no-match-path "test/{fork,differential,formal}/*" --summary \| grep "^Ran" > ../scripts/charts/data/forge-tests.txt`; edit `tests.json` from the commands it lists |
| Coverage by contract                | `coverage-by-contract-*`    | [`data/coverage.txt`](data/coverage.txt)                                                                                                          | `make coverage`, then copy the table from `\| File` down                                                                                                                                         |
| Gas, Solidity vs Stylus             | `gas-stylus-vs-solidity-*`  | [`docs/gas.md`](../../docs/gas.md), parsed directly                                                                                               | `scripts/stylus-gas.sh` and `scripts/stylus-e2e.sh`, then update `docs/gas.md`                                                                                                                   |
| Backtest equity curves              | `backtest-equity-*`         | [`research/results/weekly_delta020_vrp115.csv`](../../research/results/weekly_delta020_vrp115.csv), [`grid.csv`](../../research/results/grid.csv) | `python3 research/backtest.py`                                                                                                                                                                   |
| Live epoch timeline                 | `live-epoch-timeline-*`     | [`data/epoch.json`](data/epoch.json)                                                                                                              | Add the transaction with its block from `cast receipt <tx> blockNumber` and its time from `cast block <n> --field timestamp`                                                                     |
| Competition matrix                  | `competition-matrix-*`      | [`data/competition.json`](data/competition.json)                                                                                                  | Edit the cells; every cell must be stated by a URL in `sources`, and anything the sources do not cover is "not described"                                                                        |
| Positioning (who picks, how priced) | `competition-positioning-*` | [`data/competition.json`](data/competition.json) (`positions`)                                                                                    | As above                                                                                                                                                                                         |

## Palette

Derived from the site palette (ink `#121212`, paper `#e9e9e7`, teal `#178f9d` / `#0e6a74`, mint `#75d0cb`) and fixed in [`theme.py`](theme.py). Categorical slots are assigned in this order and never cycled.

| Role                      | Light (on paper `#e9e9e7`) | Dark (on ink `#121212`) |
| ------------------------- | -------------------------- | ----------------------- |
| Slot 1, teal              | `#0a8a9f`                  | `#1aa3b3`               |
| Slot 2, coral             | `#cf5a24`                  | `#e0703a`               |
| Slot 3, violet            | `#7457c8`                  | `#8a74dc`               |
| Context series (gray)     | `#6f6f69` (4.2:1)          | `#8d8d86` (5.6:1)       |
| Primary text              | `#121212` (15.4:1)         | `#e9e9e7` (15.4:1)      |
| Secondary text            | `#45453f` (7.9:1)          | `#bdbdb6` (9.9:1)       |
| Muted text (ticks, notes) | `#5f5f59` (5.3:1)          | `#9a9a93` (6.6:1)       |
| Gridline                  | `#d4d4d0`                  | `#282826`               |

The site teal `#178f9d` fails the chroma floor (OKLCH C 0.098 < 0.10, it reads as gray-teal) and the darker `#0e6a74` fails it too (0.079), so slot 1 is the nearest teal step that passes, `#0a8a9f`. Mint `#75d0cb` is too light for marks on paper (OKLCH L 0.80, above the 0.77 band; 1.48:1 contrast). Coral and violet were added as the second and third hues, then the order was checked in both modes. Text contrast was measured with the validator's `contrast()` export.

Charts use at most three categorical series. Where a chart is about one thing, it uses emphasis instead: Strike in teal and everything else in the context gray (the positioning chart), or one hue for every bar (tests by suite).

### Validator output

Run with the dataviz skill's `validate_palette.js` (Machado 2009 CVD simulation, ΔE in OKLab ×100), adjacent pairs and all pairs, in both modes:

```text
$ node validate_palette.js "#0a8a9f,#cf5a24,#7457c8" --mode light --surface "#e9e9e7"
Palette (light, surface #e9e9e7, categorical): 3 slots
  [PASS] Lightness band         all 3 inside L 0.43–0.77
  [PASS] Chroma floor           all 3 >= 0.1
  [PASS] CVD separation         worst adjacent #cf5a24↔#0a8a9f ΔE 16.5 (protan) · tritan 24.1
  [PASS] Normal-vision floor    worst adjacent #cf5a24↔#0a8a9f ΔE 26.3 (normal)
  [PASS] Contrast vs surface    all 3 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
exit 0
$ node validate_palette.js "#0a8a9f,#cf5a24,#7457c8" --mode light --surface "#e9e9e7" --pairs all
Palette (light, surface #e9e9e7, categorical): 3 slots
  [PASS] Lightness band         all 3 inside L 0.43–0.77
  [PASS] Chroma floor           all 3 >= 0.1
  [PASS] CVD separation         worst all-pairs #7457c8↔#0a8a9f ΔE 11.1 (deutan) · tritan 10.8
  [PASS] Normal-vision floor    worst all-pairs #7457c8↔#0a8a9f ΔE 18.2 (normal)
  [PASS] Contrast vs surface    all 3 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
exit 0
$ node validate_palette.js "#1aa3b3,#e0703a,#8a74dc" --mode dark --surface "#121212"
Palette (dark, surface #121212, categorical): 3 slots
  [PASS] Lightness band         all 3 inside L 0.48–0.67
  [PASS] Chroma floor           all 3 >= 0.1
  [PASS] CVD separation         worst adjacent #e0703a↔#1aa3b3 ΔE 16.5 (protan) · tritan 22.5
  [PASS] Normal-vision floor    worst adjacent #8a74dc↔#e0703a ΔE 26.1 (normal)
  [PASS] Contrast vs surface    all 3 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
exit 0
$ node validate_palette.js "#1aa3b3,#e0703a,#8a74dc" --mode dark --surface "#121212" --pairs all
Palette (dark, surface #121212, categorical): 3 slots
  [PASS] Lightness band         all 3 inside L 0.48–0.67
  [PASS] Chroma floor           all 3 >= 0.1
  [PASS] CVD separation         worst all-pairs #8a74dc↔#1aa3b3 ΔE 9.4 (deutan) · tritan 11.1
  [PASS] Normal-vision floor    worst all-pairs #8a74dc↔#1aa3b3 ΔE 17.9 (normal)
  [PASS] Contrast vs surface    all 3 >= 3:1
  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
exit 0
```

## Rules the charts follow

- The form comes from the data's job: horizontal bars for counts, dot plots for coverage against a gate, a log-scale dumbbell for gas (values span 25k to 1.9M), small multiples for the four backtest tickers, a list for the epoch, a table for the matrix.
- One axis per chart; no dual axes. The coverage axis starts at 88% and says so.
- Thin marks: 2px lines, dots with a 2px surface ring, hairline solid gridlines.
- A legend only when there are two or more series; values are labelled directly where they matter.
- Text uses the ink colours, never a series colour.
- Every chart has an explicit background, in both a light and a dark variant, and the README gives its numbers in a table or caption next to it.
