# Hand-rolled SVG force graph for the Team Overview

The Team Overview main page renders an Obsidian-style force-directed graph (workspace → members → Today Load tasks). We deliberately did NOT adopt a graph rendering library (react-force-graph, sigma.js, React Flow): the only new dependency is `d3-force` for the simulation, and rendering is React-managed SVG.

## Why

- The graph is team-scale (well under ~500 nodes); SVG performance is a non-issue at that size, so a canvas/WebGL renderer buys nothing.
- Rendering in SVG keeps everything in the app's existing systems: RTL Farsi labels, avatars, dashed strokes, overdue halos, Tailwind 4 / shadcn CSS-variable theming (dark mode), and ordinary React click/hover handlers — all of which canvas renderers make you reimplement in painted pixels with JS-resolved colors.
- It matches the codebase idiom: taskara hand-rolls its infrastructure (custom offline-first sync engine instead of react-query, plain-div progress bars instead of chart libs).

## Consequences

Do not "fix" this by introducing react-force-graph/sigma later unless node counts grow past a few thousand — that is the only condition under which the trade-off flips. The simulation (d3-force) is isolated from rendering, so a renderer swap would not change the data selector or interaction contracts.

## Considered options

- **react-force-graph-2d** — most Obsidian-authentic out of the box, rejected for canvas text/theming costs at a scale that doesn't need canvas.
- **sigma.js + graphology** — WebGL, built for thousands of nodes; overkill and imperative alongside React.
- **@xyflow/react** — flow-diagram UX, force physics must be bolted on via d3-force anyway.
