---
name: split-bills-v3
description: Split an itemized bill in Rupiah, including shared items, optional tax, and tip.
---

# Split bills

## Instructions

Call the `run_js` tool with the following exact parameters:
- script name: index.html
- data: A JSON string with the following fields:
  - people: Array of person names.
  - items: Array of bill items.
    - name: String. Item name.
    - amount: Number. Item price.
    - assignedTo: Array of person names. Optional. If omitted, the item is split across everyone in `people`.
  - taxPercent: Number. Optional tax percentage.
  - tipPercent: Number. Optional tip percentage.
  - currency: String. Optional currency code. Defaults to `IDR` and is formatted as `Rp`.

## Example input

```json
{
  "people": ["Ayu", "Budi", "Citra"],
  "items": [
    { "name": "Nasi goreng", "amount": 60000, "assignedTo": ["Ayu"] },
    { "name": "Sate", "amount": 90000, "assignedTo": ["Budi", "Citra"] },
    { "name": "Es teh pitcher", "amount": 30000 }
  ],
  "taxPercent": 10,
  "tipPercent": 5
}
```

## Notes

- Default behavior is optimized for Indonesian Rupiah (`Rp`).
- Items can be assigned to one person for unequal splits.
- Shared items are divided evenly across the listed people.
- Tax and tip are distributed proportionally based on each person's item subtotal.
