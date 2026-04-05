---
name: split-bills-v3
description: split an itemized bill in rupiah for ai edge gallery. use when the user wants to divide receipt items across named people, calculate tax and tip, and optionally compute who owes whom after one or more people already paid the bill. supports shared items, exact per-person breakdowns, and reimbursement instructions such as 'ayu pays budi rp45.000'.
---

# Split bills v3

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
  - currency: String. Optional ISO currency code. Defaults to `IDR` and is formatted as `Rp`.
  - paidBy: String. Optional shorthand meaning this one person paid the full grand total.
  - payments: Array. Optional explicit payments that must sum to the grand total if reimbursement instructions are needed.
    - person: String. Person name.
    - amount: Number. Amount already paid by that person.

Use `paidBy` for the common case where one person paid first.
Use `payments` when multiple people paid parts of the bill.
Do not provide both `paidBy` and `payments` at the same time.

## Example input: split only

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

## Example input: reimbursement flow

```json
{
  "people": ["Ayu", "Budi", "Citra"],
  "items": [
    { "name": "Nasi goreng", "amount": 60000, "assignedTo": ["Ayu"] },
    { "name": "Sate", "amount": 90000, "assignedTo": ["Budi", "Citra"] },
    { "name": "Es teh pitcher", "amount": 30000 }
  ],
  "taxPercent": 10,
  "tipPercent": 5,
  "paidBy": "Ayu"
}
```

## Notes

- Default behavior is optimized for Indonesian Rupiah (`Rp`).
- Shared items are divided exactly, with remainder balancing so totals stay exact.
- Tax and tip are distributed proportionally based on each person's item subtotal.
- If payment information is provided, return reimbursement instructions with the fewest practical transfers.
