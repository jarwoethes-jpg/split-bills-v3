---
name: split-bills-v3
description: Split a bill equally and include optional tax and tip.
---

# Split bills

## Instructions

Call the `run_js` tool with the following exact parameters:
- script name: index.html
- data: A JSON string with the following fields:
  - total: Number. The bill subtotal before tax and tip.
  - people: Number. The number of people splitting the bill equally.
  - taxPercent: Number. Optional tax percentage.
  - tipPercent: Number. Optional tip percentage.
