---
name: dataviz
description: Guide for building charts and dashboards with accessible colour palettes. Use for any chart, graph, plot or dashboard, or when choosing series colours. Includes a palette validator script to run before finishing.
---

# Data visualisation

## 1. Pick the form from the question

| The reader wants to… | Use |
|---|---|
| compare values across categories | horizontal bar chart (sorted), not pie |
| see change over time | line chart (bars for few, discrete periods) |
| see a distribution | histogram or box plot |
| see a relationship | scatter plot |
| see part-to-whole with ≤ 4 parts | stacked bar; pie only if the user insists |

Start axes at zero for bars. Do not use dual y-axes, 3-D effects or decorative gradients.

## 2. Colour

- Use colour only to encode data. One series → one neutral or accent colour.
- Categorical: at most 6–8 hues; beyond that, group into "Other" or use small multiples.
- Sequential data: one hue varying in lightness. Diverging data: two hues around a neutral midpoint.
- Never rely on colour alone: add direct labels, markers or patterns.
- Make light and dark themes both work: test the palette against each background.

**Before finishing, validate every categorical palette** with the bundled script:

```
node <skill folder>/validate_palette.mjs --background "#ffffff" "#0072B2" "#D55E00" "#009E73" "#CC79A7"
```

(That example, from the Okabe–Ito palette, passes on both white and `#111827`. Many popular palettes do not: blue next to purple, or green next to pink, often collapse for colour-blind readers.)

Run it again with the dark background (e.g. `--background "#111827"`). It exits with code 1 and explains which pairs fail. Fix the palette and re-run until it passes. Report the final results to the user.

What it checks:
- every colour has at least 3:1 contrast with the background (WCAG 2.1, non-text contrast);
- every pair of colours is clearly distinguishable (CIEDE2000 ΔE ≥ 15 for normal vision, ≥ 8 under simulated protanopia, deuteranopia and tritanopia).

## 3. Text and interaction

- Title states the takeaway ("Revenue doubled in Q3"), not the variables.
- Label axes with units; format numbers (1.2k, 45%).
- Prefer direct labels to legends; if you need a legend, order it like the data.
- Tooltips repeat the exact value and the series name; keyboard users must reach the same information.

## 4. Verify

Render the chart (start the dev server with start_process, take a screenshot if a browser tool is available, and look at it with view_image), check both themes, and run the validator. Say in your final report which of these you did.
