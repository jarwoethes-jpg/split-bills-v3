---
name: split-bills-v3
description: split bills for ai edge gallery. use when the user wants to divide a receipt or bill across named people, accept bahasa indonesia or english input, support natural-language notes, receipt ocr text from a bill photo, discount, service charge, tax, tip, optional rounding, and reimbursement flows such as 'ayu bayar budi rp45.000'.
---

# Split bills v3

## Workflow

1. Decide the input mode.
   - **Structured JSON already known**: pass the JSON directly.
   - **Natural language in English or Bahasa Indonesia**: pass the text directly.
   - **Bill photo provided**: pass the image as `receiptImageDataUrl`, `receiptImageBase64`, or `receiptImageUrl`. The skill will try OCR first, then run the same accounting engine on the extracted receipt lines.
2. Let `scripts/split-bills.js` be the single accounting engine.
3. Ask one short follow-up instead of guessing when people or item ownership are still missing.

## Call `run_js`

Use these exact parameters:
- script name: `index.html`
- data: one of:
  - a JSON string, or
  - a plain-text multiline bill description

## Supported JSON fields

- `people`: array of person names
- `items`: array of objects with:
  - `name`: string
  - `amount`: number
  - `assignedTo`: array of person names
- `text`: optional natural-language bill notes in English or Bahasa Indonesia
- `ocrText` or `receiptText`: optional receipt lines, either user-provided or produced by OCR
- `receiptImageDataUrl`, `receiptImageBase64`, `receiptImageUrl`: optional bill image inputs for OCR
- `currency`: optional ISO currency code, defaults to `IDR`
- `language`: optional `en` or `id`
- `discountPercent`, `discountAmount`
- `servicePercent` or `serviceChargePercent`
- `serviceAmount` or `serviceChargeAmount`
- `taxPercent`, `taxAmount`
- `tipPercent`, `tipAmount`
- `rounding`: optional rounding increment such as `500` or `1000`
- `paidBy`: one person paid the full total
- `payments`: explicit per-person payments that must sum to the grand total

## Supported text patterns

### People
- `people: Ayu, Budi, Citra`
- `orang: Ayu, Budi, Citra`

### Item lines with amount
- `Ayu had nasi goreng 60000`
- `Ayu makan nasi goreng 60.000`
- `Budi and Citra shared sate 90000`
- `Budi dan Citra patungan sate 90.000`
- `Es teh 30000 for all`
- `Es teh 30.000 buat semua`

### OCR receipt lines
Use these when a bill photo was transcribed first:
- `Nasi goreng 60000`
- `Sate 90000`
- `Es teh pitcher 30000`
- `Pajak 10%`
- `Service charge 5%`
- `Diskon 20000`

Then optionally add ownership or payer lines:
- `Ayu makan nasi goreng`
- `Budi dan Citra patungan sate`
- `Es teh pitcher buat semua`
- `Ayu bayar semua`

### Payment lines
- `Ayu paid all`
- `Ayu bayar semua`
- `Budi paid 50000`
- `Budi bayar 50.000`

### Totals and adjustments
- `Tax 10%`
- `Pajak 10%`
- `Tip 5%`
- `Discount 20000`
- `Diskon 20.000`
- `Voucher 10%`
- `Service charge 5%`
- `Biaya layanan 7,5%`
- `Round 500`
- `Pembulatan 1000`

## Important rules

- Use `paidBy` for the common one-payer case.
- Use `payments` when multiple people already paid.
- Do not provide both at once.
- Rounding is only a suggestion layer on top of exact accounting; totals must remain exact.
- Discounts are applied before service charge, tax, and tip.
- Service charge is added before tax and tip are calculated.
- For receipt OCR, preserve uncertainty instead of inventing values. Ask one short follow-up if the image text is still unclear.
