(function (root) {
  const WHOLE_UNIT_CURRENCIES = new Set(['IDR', 'JPY']);
  const SUPPORTED_CURRENCIES = new Set(['IDR', 'USD', 'EUR', 'GBP', 'SGD', 'JPY', 'AUD', 'MYR']);
  const ID_LANGUAGE_HINTS = /(\b(orang|peserta|pajak|ppn|diskon|voucher|promo|biaya layanan|service charge|bayar|buat semua|untuk semua|patungan|bareng|makan|pesan|ambil|bulatkan|pembulatan)\b)/i;

  const LABELS = {
    en: {
      subtotal: 'Subtotal',
      discount: 'Discount',
      service: 'Service charge',
      tax: 'Tax',
      tip: 'Tip',
      grandTotal: 'Grand total',
      perPerson: 'Per person',
      settlements: 'Settlement',
      rounded: 'Rounded suggestion',
      balancing: 'balancing line',
      items: 'items',
      paid: 'paid',
      owes: 'owes',
      toReceive: 'to receive',
      pays: 'pays',
      assumptions: 'Assumptions',
      warnings: 'Warnings'
    },
    id: {
      subtotal: 'Subtotal',
      discount: 'Diskon',
      service: 'Biaya layanan',
      tax: 'Pajak',
      tip: 'Tip',
      grandTotal: 'Total akhir',
      perPerson: 'Per orang',
      settlements: 'Alur bayar',
      rounded: 'Saran pembulatan',
      balancing: 'baris penyeimbang',
      items: 'item',
      paid: 'sudah bayar',
      owes: 'kurang bayar',
      toReceive: 'menerima',
      pays: 'bayar',
      assumptions: 'Asumsi',
      warnings: 'Catatan'
    }
  };

  async function run(rawData) {
    try {
      const input = parseIncomingInput(rawData);
      const prepared = await prepareInput(input);
      if (prepared.needsFollowUp) {
        return {
          result: prepared.message,
          needsFollowUp: true,
          breakdown: prepared.breakdown
        };
      }
      return computeBill(prepared);
    } catch (error) {
      const message = error && error.message ? error.message : 'Unknown error';
      if (/need|still need|receipt|people|assignee|price|item|ocr|image/i.test(message)) {
        return { result: message, needsFollowUp: true };
      }
      return { error: message };
    }
  }

  function parseIncomingInput(rawData) {
    if (rawData && typeof rawData === 'object' && !Array.isArray(rawData)) {
      return rawData;
    }
    const rawText = String(rawData || '').trim();
    if (!rawText) {
      throw new Error('input is empty');
    }
    if (/^[\[{]/.test(rawText)) {
      try {
        return JSON.parse(rawText);
      } catch (_error) {
        return { text: rawText };
      }
    }
    return { text: rawText };
  }

  async function prepareInput(input) {
    const text = firstNonEmpty(input.text, input.input);
    const rawReceiptText = firstNonEmpty(input.receiptText, input.ocrText);
    const imageSource = getReceiptImageSource(input);
    const textParsed = text ? parseNarrativeText(text) : emptyParsed();
    const assumptions = [];
    const ocrWarnings = [];
    let receiptText = rawReceiptText;

    const initialLanguage = input.language === 'id' || input.language === 'en'
      ? input.language
      : text
        ? detectLanguage(text)
        : rawReceiptText
          ? detectLanguage(rawReceiptText)
          : 'en';

    if (!receiptText && imageSource) {
      try {
        receiptText = await extractReceiptTextFromImage(imageSource);
        assumptions.push(initialLanguage === 'id'
          ? 'Teks struk diekstrak otomatis dari gambar.'
          : 'Receipt text was extracted automatically from the image.');
      } catch (error) {
        const message = error && error.message ? error.message : 'OCR failed';
        ocrWarnings.push(message);
      }
    }

    const receiptParsed = receiptText ? parseReceiptText(receiptText) : emptyParsed();
    const language = input.language === 'id' || input.language === 'en'
      ? input.language
      : text
        ? detectLanguage(text)
        : receiptText
          ? detectLanguage(receiptText)
          : initialLanguage;
    const currency = normalizeCurrency(firstDefined(input.currency, textParsed.currency, receiptParsed.currency, 'IDR'));
    const scale = getScaleForCurrency(currency);

    const explicitPeople = Array.isArray(input.people) ? uniqueStrings(input.people) : [];
    const people = uniqueStrings([].concat(explicitPeople, textParsed.people));
    const warnings = []
      .concat(textParsed.warnings || [])
      .concat(receiptParsed.warnings || [])
      .concat(ocrWarnings);

    if (!receiptText && imageSource) {
      return followUp(
        language,
        language === 'id'
          ? 'Aku belum bisa membaca foto struknya dengan jelas. Coba kirim gambar yang lebih jelas, atau kirim `ocrText` / teks struknya.'
          : 'I could not read the receipt image clearly yet. Try a clearer image, or pass `ocrText` / the receipt text directly.',
        {
          parsing: buildParsingBreakdown(textParsed, receiptParsed, assumptions, warnings),
          imageProvided: true
        }
      );
    }

    let items = [];
    if (Array.isArray(input.items) && input.items.length) {
      items = input.items.map(function (item) {
        return {
          name: String(item.name || '').trim(),
          amount: item.amount,
          assignedTo: Array.isArray(item.assignedTo) ? item.assignedTo.slice() : undefined
        };
      });
    } else if (receiptParsed.receiptItems.length) {
      items = applyReceiptItems(receiptParsed.receiptItems, textParsed.itemHints, people, assumptions);
    } else {
      items = finalizeNarrativeItems(textParsed.items, textParsed.pendingItems, people, textParsed.splitEqually, assumptions);
    }

    if (!items.length) {
      return followUp(
        language,
        language === 'id'
          ? 'Aku masih butuh daftar item dan harga, atau teks hasil OCR struk, sebelum bisa membagi tagihan.'
          : 'I still need item lines and prices, or OCR text from the receipt, before I can split the bill.',
        {
          parsing: buildParsingBreakdown(textParsed, receiptParsed, assumptions, warnings)
        }
      );
    }

    const missingAmounts = items.filter(function (item) {
      return item.amount === undefined || item.amount === null || item.amount === '';
    });
    if (missingAmounts.length) {
      return followUp(
        language,
        (language === 'id'
          ? 'Aku masih butuh harga untuk item ini: '
          : 'I still need prices for these items: ') + missingAmounts.map(function (item) { return item.name; }).join(', '),
        {
          parsing: buildParsingBreakdown(textParsed, receiptParsed, assumptions, warnings)
        }
      );
    }

    if (!people.length) {
      return followUp(
        language,
        language === 'id'
          ? 'Aku sudah bisa baca tagihannya, tapi masih butuh siapa saja yang membagi tagihan. Contoh: orang: Ayu, Budi.'
          : 'I could read the bill, but I still need the people who are splitting it. Example: people: Ayu, Budi.',
        {
          parsing: buildParsingBreakdown(textParsed, receiptParsed, assumptions, warnings),
          extractedItems: items.map(function (item) { return { name: item.name, amount: item.amount }; })
        }
      );
    }

    const normalizedItems = normalizeItems(items, people, scale, assumptions);

    const paidBy = firstNonEmpty(input.paidBy, textParsed.paidBy);
    const payments = Array.isArray(input.payments) && input.payments.length ? input.payments : textParsed.payments;

    return {
      needsFollowUp: false,
      language: language,
      currency: currency,
      scale: scale,
      people: people,
      items: normalizedItems,
      discountPercent: normalizePercent(firstDefined(input.discountPercent, textParsed.discountPercent, receiptParsed.discountPercent, 0), 'discountPercent'),
      discountAmountUnits: toUnits(firstDefined(input.discountAmount, textParsed.discountAmount, receiptParsed.discountAmount, 0), scale, 'discountAmount'),
      servicePercent: normalizePercent(firstDefined(input.servicePercent, input.serviceChargePercent, textParsed.servicePercent, receiptParsed.servicePercent, 0), 'servicePercent'),
      serviceAmountUnits: toUnits(firstDefined(input.serviceAmount, input.serviceChargeAmount, textParsed.serviceAmount, receiptParsed.serviceAmount, 0), scale, 'serviceAmount'),
      taxPercent: normalizePercent(firstDefined(input.taxPercent, textParsed.taxPercent, receiptParsed.taxPercent, 0), 'taxPercent'),
      taxAmountUnits: toUnits(firstDefined(input.taxAmount, textParsed.taxAmount, receiptParsed.taxAmount, 0), scale, 'taxAmount'),
      tipPercent: normalizePercent(firstDefined(input.tipPercent, textParsed.tipPercent, receiptParsed.tipPercent, 0), 'tipPercent'),
      tipAmountUnits: toUnits(firstDefined(input.tipAmount, textParsed.tipAmount, receiptParsed.tipAmount, 0), scale, 'tipAmount'),
      roundingIncrementUnits: normalizeRounding(firstDefined(input.rounding, textParsed.rounding, receiptParsed.rounding, 0), scale),
      paidBy: paidBy,
      payments: normalizePayments(payments, paidBy, people, scale),
      parserWarnings: warnings,
      assumptions: assumptions,
      parsing: buildParsingBreakdown(textParsed, receiptParsed, assumptions, warnings)
    };
  }

  function computeBill(input) {
    const t = LABELS[input.language] || LABELS.en;
    const personMap = new Map();
    input.people.forEach(function (person) {
      personMap.set(person, {
        name: person,
        itemSubtotalUnits: 0,
        discountShareUnits: 0,
        serviceShareUnits: 0,
        taxShareUnits: 0,
        tipShareUnits: 0,
        totalUnits: 0,
        paidUnits: 0,
        netUnits: 0,
        items: []
      });
    });

    let subtotalUnits = 0;
    input.items.forEach(function (item) {
      subtotalUnits += item.amountUnits;
      splitAmountExactly(item.amountUnits, item.assignedTo).forEach(function (share) {
        const entry = personMap.get(share.person);
        entry.itemSubtotalUnits += share.amountUnits;
        entry.items.push({
          name: item.name,
          shareUnits: share.amountUnits,
          sharedWith: item.assignedTo.length > 1 ? item.assignedTo.slice() : undefined
        });
      });
    });

    const itemWeights = input.people.map(function (person) { return personMap.get(person).itemSubtotalUnits; });
    const discountPercentUnits = percentToUnits(subtotalUnits, input.discountPercent);
    const discountAmountUnits = Math.min(subtotalUnits, discountPercentUnits + input.discountAmountUnits);
    const discountShares = allocateProportionally(discountAmountUnits, itemWeights);
    input.people.forEach(function (person, index) {
      personMap.get(person).discountShareUnits = discountShares[index];
    });

    const discountedWeights = input.people.map(function (person, index) {
      return Math.max(0, personMap.get(person).itemSubtotalUnits - discountShares[index]);
    });
    const discountedSubtotalUnits = Math.max(0, subtotalUnits - discountAmountUnits);

    const servicePercentUnits = percentToUnits(discountedSubtotalUnits, input.servicePercent);
    const serviceAmountUnits = servicePercentUnits + input.serviceAmountUnits;
    const serviceShares = allocateProportionally(serviceAmountUnits, discountedWeights);
    input.people.forEach(function (person, index) {
      personMap.get(person).serviceShareUnits = serviceShares[index];
    });

    const taxBaseUnits = discountedSubtotalUnits + serviceAmountUnits;
    const taxPercentUnits = percentToUnits(taxBaseUnits, input.taxPercent);
    const taxAmountUnits = taxPercentUnits + input.taxAmountUnits;
    const taxShares = allocateProportionally(taxAmountUnits, discountedWeights);
    input.people.forEach(function (person, index) {
      personMap.get(person).taxShareUnits = taxShares[index];
    });

    const tipBaseUnits = discountedSubtotalUnits + serviceAmountUnits;
    const tipPercentUnits = percentToUnits(tipBaseUnits, input.tipPercent);
    const tipAmountUnits = tipPercentUnits + input.tipAmountUnits;
    const tipShares = allocateProportionally(tipAmountUnits, discountedWeights);
    input.people.forEach(function (person, index) {
      personMap.get(person).tipShareUnits = tipShares[index];
    });

    input.people.forEach(function (person) {
      const entry = personMap.get(person);
      entry.totalUnits =
        entry.itemSubtotalUnits -
        entry.discountShareUnits +
        entry.serviceShareUnits +
        entry.taxShareUnits +
        entry.tipShareUnits;
    });

    const grandTotalUnits = discountedSubtotalUnits + serviceAmountUnits + taxAmountUnits + tipAmountUnits;

    const payments = materializePayments(input.payments, input.paidBy, input.people, grandTotalUnits, input.scale);
    if (payments.length) {
      const paidTotal = payments.reduce(function (sum, payment) { return sum + payment.amountUnits; }, 0);
      if (paidTotal !== grandTotalUnits) {
        throw new Error('payments must add up exactly to the grand total');
      }
      payments.forEach(function (payment) {
        personMap.get(payment.person).paidUnits += payment.amountUnits;
      });
      input.people.forEach(function (person) {
        const entry = personMap.get(person);
        entry.netUnits = entry.paidUnits - entry.totalUnits;
      });
    }

    const rows = input.people.map(function (person) { return personMap.get(person); });
    const settlements = payments.length ? settleBalances(rows) : [];
    const rounded = input.roundingIncrementUnits ? buildRoundedOutputs(rows, settlements, input.roundingIncrementUnits, grandTotalUnits) : null;

    const resultLines = [];
    resultLines.push(t.subtotal + ': ' + formatMoney(subtotalUnits, input.currency, input.scale));
    if (discountAmountUnits > 0) resultLines.push(t.discount + ': -' + formatMoney(discountAmountUnits, input.currency, input.scale));
    if (serviceAmountUnits > 0) resultLines.push(t.service + formatPercentSuffix(input.servicePercent, t, input.language) + ': ' + formatMoney(serviceAmountUnits, input.currency, input.scale));
    if (taxAmountUnits > 0) resultLines.push(t.tax + formatPercentSuffix(input.taxPercent, t, input.language) + ': ' + formatMoney(taxAmountUnits, input.currency, input.scale));
    if (tipAmountUnits > 0) resultLines.push(t.tip + formatPercentSuffix(input.tipPercent, t, input.language) + ': ' + formatMoney(tipAmountUnits, input.currency, input.scale));
    resultLines.push(t.grandTotal + ': ' + formatMoney(grandTotalUnits, input.currency, input.scale));
    resultLines.push('', t.perPerson + ':');

    rows.forEach(function (row) {
      const parts = [t.items + ' ' + formatMoney(row.itemSubtotalUnits, input.currency, input.scale)];
      if (row.discountShareUnits > 0) parts.push(t.discount.toLowerCase() + ' ' + formatMoney(row.discountShareUnits, input.currency, input.scale));
      if (row.serviceShareUnits > 0) parts.push(t.service.toLowerCase() + ' ' + formatMoney(row.serviceShareUnits, input.currency, input.scale));
      if (row.taxShareUnits > 0) parts.push(t.tax.toLowerCase() + ' ' + formatMoney(row.taxShareUnits, input.currency, input.scale));
      if (row.tipShareUnits > 0) parts.push(t.tip.toLowerCase() + ' ' + formatMoney(row.tipShareUnits, input.currency, input.scale));
      if (row.paidUnits > 0) {
        parts.push(t.paid + ' ' + formatMoney(row.paidUnits, input.currency, input.scale));
        parts.push((row.netUnits >= 0 ? t.toReceive : t.owes) + ' ' + formatMoney(Math.abs(row.netUnits), input.currency, input.scale));
      }
      resultLines.push('- ' + row.name + ': ' + formatMoney(row.totalUnits, input.currency, input.scale) + ' (' + parts.join(', ') + ')');
    });

    if (settlements.length) {
      resultLines.push('', t.settlements + ':');
      settlements.forEach(function (settlement) {
        resultLines.push('- ' + settlement.from + ' ' + t.pays + ' ' + settlement.to + ' ' + formatMoney(settlement.amountUnits, input.currency, input.scale));
      });
    }

    if (rounded) {
      resultLines.push('', t.rounded + ' (' + formatMoney(input.roundingIncrementUnits, input.currency, input.scale) + '):');
      if (rounded.roundedSettlements.length) {
        rounded.roundedSettlements.forEach(function (entry, index) {
          const exact = settlements[index];
          const suffix = entry.balancing ? ' (' + t.balancing + ')' : '';
          resultLines.push('- ' + exact.from + ' ' + t.pays + ' ' + exact.to + ' ' + formatMoney(entry.roundedUnits, input.currency, input.scale) + suffix);
        });
      } else {
        rounded.roundedPerPerson.forEach(function (entry) {
          const suffix = entry.balancing ? ' (' + t.balancing + ')' : '';
          resultLines.push('- ' + entry.key + ': ' + formatMoney(entry.roundedUnits, input.currency, input.scale) + suffix);
        });
      }
    }

    if (input.assumptions.length) {
      resultLines.push('', t.assumptions + ':');
      input.assumptions.forEach(function (assumption) { resultLines.push('- ' + assumption); });
    }
    if (input.parserWarnings.length) {
      resultLines.push('', t.warnings + ':');
      input.parserWarnings.forEach(function (warning) { resultLines.push('- ' + warning); });
    }

    return {
      result: resultLines.join('\n'),
      breakdown: {
        currency: input.currency,
        language: input.language,
        subtotal: fromUnits(subtotalUnits, input.scale),
        discountAmount: fromUnits(discountAmountUnits, input.scale),
        discountPercent: input.discountPercent,
        serviceAmount: fromUnits(serviceAmountUnits, input.scale),
        servicePercent: input.servicePercent,
        taxPercent: input.taxPercent,
        taxAmount: fromUnits(taxAmountUnits, input.scale),
        tipPercent: input.tipPercent,
        tipAmount: fromUnits(tipAmountUnits, input.scale),
        grandTotal: fromUnits(grandTotalUnits, input.scale),
        people: rows.map(function (row) {
          return {
            name: row.name,
            itemSubtotal: fromUnits(row.itemSubtotalUnits, input.scale),
            discountShare: fromUnits(row.discountShareUnits, input.scale),
            serviceShare: fromUnits(row.serviceShareUnits, input.scale),
            taxShare: fromUnits(row.taxShareUnits, input.scale),
            tipShare: fromUnits(row.tipShareUnits, input.scale),
            total: fromUnits(row.totalUnits, input.scale),
            paid: fromUnits(row.paidUnits, input.scale),
            net: fromUnits(row.netUnits, input.scale),
            items: row.items.map(function (item) {
              return {
                name: item.name,
                share: fromUnits(item.shareUnits, input.scale),
                sharedWith: item.sharedWith
              };
            })
          };
        }),
        items: input.items.map(function (item) {
          return {
            name: item.name,
            amount: fromUnits(item.amountUnits, input.scale),
            assignedTo: item.assignedTo
          };
        }),
        payments: payments.map(function (payment) {
          return { person: payment.person, amount: fromUnits(payment.amountUnits, input.scale) };
        }),
        settlements: settlements.map(function (settlement) {
          return { from: settlement.from, to: settlement.to, amount: fromUnits(settlement.amountUnits, input.scale) };
        }),
        rounding: rounded ? serializeRounded(rounded, input.scale) : null,
        parsing: input.parsing,
        parserWarnings: input.parserWarnings,
        assumptions: input.assumptions
      }
    };
  }

  function parseNarrativeText(text) {
    const state = {
      people: [],
      items: [],
      itemHints: [],
      pendingItems: [],
      payments: [],
      paidBy: null,
      currency: null,
      taxPercent: undefined,
      taxAmount: undefined,
      tipPercent: undefined,
      tipAmount: undefined,
      discountPercent: undefined,
      discountAmount: undefined,
      servicePercent: undefined,
      serviceAmount: undefined,
      rounding: undefined,
      splitEqually: false,
      warnings: []
    };

    splitFacts(text).forEach(function (line) {
      if (parsePeopleLine(line, state)) return;
      if (parseCurrencyLine(line, state)) return;
      if (parseAdjustmentPercentLine(line, state)) return;
      if (parseAdjustmentAmountLine(line, state)) return;
      if (parseRoundingLine(line, state)) return;
      if (parsePaidByLine(line, state)) return;
      if (parsePaymentLine(line, state)) return;
      if (parseSplitEquallyLine(line, state)) return;
      if (parseItemLine(line, state)) return;
      if (parseAssignmentHintLine(line, state)) return;
      state.warnings.push('Unparsed line: ' + line);
    });

    state.people = uniqueStrings(state.people);
    return state;
  }

  function parseReceiptText(text) {
    const state = emptyParsed();
    splitFacts(text).forEach(function (line) {
      if (parseCurrencyLine(line, state)) return;
      if (parseAdjustmentPercentLine(line, state)) return;
      if (parseAdjustmentAmountLine(line, state)) return;
      if (parseReceiptItemLine(line, state)) return;
      state.warnings.push('Unparsed OCR line: ' + line);
    });
    return state;
  }

  function parsePeopleLine(line, state) {
    const match = line.match(/^(?:people|orang|peserta)\s*:\s*(.+)$/i);
    if (!match) return false;
    state.people.push.apply(state.people, parseNamedList(match[1]));
    return true;
  }

  function parseCurrencyLine(line, state) {
    const match = line.match(/^(?:currency|mata uang)\s*:\s*([a-z]{3})$/i);
    if (!match) return false;
    state.currency = match[1].toUpperCase();
    return true;
  }

  function parseAdjustmentPercentLine(line, state) {
    const tax = parsePercentLine(line, ['tax', 'pajak', 'ppn']);
    if (tax !== null) { state.taxPercent = tax; return true; }
    const tip = parsePercentLine(line, ['tip']);
    if (tip !== null) { state.tipPercent = tip; return true; }
    const discount = parsePercentLine(line, ['discount', 'diskon', 'voucher', 'promo']);
    if (discount !== null) { state.discountPercent = discount; return true; }
    const service = parsePercentLine(line, ['service charge', 'service', 'biaya layanan']);
    if (service !== null) { state.servicePercent = service; return true; }
    return false;
  }

  function parseAdjustmentAmountLine(line, state) {
    const tax = parseAmountLine(line, ['tax', 'pajak', 'ppn']);
    if (tax !== null) { state.taxAmount = tax; return true; }
    const tip = parseAmountLine(line, ['tip']);
    if (tip !== null) { state.tipAmount = tip; return true; }
    const discount = parseAmountLine(line, ['discount', 'diskon', 'voucher', 'promo']);
    if (discount !== null) { state.discountAmount = discount; return true; }
    const service = parseAmountLine(line, ['service charge', 'service', 'biaya layanan']);
    if (service !== null) { state.serviceAmount = service; return true; }
    return false;
  }

  function parseRoundingLine(line, state) {
    const match = line.match(/^(?:round(?:ing)?(?: to)?|bulatkan|pembulatan)\s*:?\s*(\d[\d.,]*)$/i);
    if (!match) return false;
    state.rounding = parseNumberToken(match[1]);
    return true;
  }

  function parsePaidByLine(line, state) {
    const match = line.match(/^(.+?)\s+(?:paid all|bayar semua|talang(?:in)? semua|nombok(?:in)? semua)$/i);
    if (!match) return false;
    const payer = match[1].trim();
    state.people.push(payer);
    state.paidBy = payer;
    state.payments = [];
    return true;
  }

  function parsePaymentLine(line, state) {
    const match = line.match(/^(.+?)\s+(?:paid|bayar)\s+((?:rp\s*)?\d[\d.,]*(?:k)?)$/i);
    if (!match) return false;
    const person = match[1].trim();
    state.people.push(person);
    state.payments.push({ person: person, amount: parseNumberToken(match[2]) });
    return true;
  }

  function parseSplitEquallyLine(line, state) {
    if (/^(?:split equally|equal split|bagi rata|patungan semua|rata semua)$/i.test(line)) {
      state.splitEqually = true;
      return true;
    }
    return false;
  }

  function parseItemLine(line, state) {
    const allMatch = line.match(/^(.*?)\s+((?:rp\s*)?\d[\d.,]*(?:k)?)\s+(?:for all|shared by all|buat semua|untuk semua)$/i);
    if (allMatch) {
      state.items.push({ name: allMatch[1].trim(), amount: parseNumberToken(allMatch[2]), assignedTo: 'all' });
      return true;
    }

    const sharedMatch = line.match(/^(.+?)\s+(?:shared|share|patungan|bareng|berbagi)\s+(.+)$/i);
    if (sharedMatch) {
      const amountInfo = extractTrailingAmount(sharedMatch[2]);
      const names = parseNamedList(sharedMatch[1]);
      if (amountInfo) {
        state.people.push.apply(state.people, names);
        state.items.push({ name: amountInfo.head, amount: amountInfo.amount, assignedTo: names });
        return true;
      }
      state.itemHints.push({ name: sharedMatch[2].trim(), assignedTo: names });
      state.people.push.apply(state.people, names);
      return true;
    }

    const singleMatch = line.match(/^(.+?)\s+(?:had|ate|ordered|got|makan|pesan|ambil)\s+(.+)$/i);
    if (singleMatch) {
      const amountInfo = extractTrailingAmount(singleMatch[2]);
      const person = singleMatch[1].trim();
      state.people.push(person);
      if (amountInfo) {
        state.items.push({ name: amountInfo.head, amount: amountInfo.amount, assignedTo: [person] });
      } else {
        state.itemHints.push({ name: singleMatch[2].trim(), assignedTo: [person] });
      }
      return true;
    }

    const bareAmount = extractTrailingAmount(line);
    if (bareAmount) {
      state.pendingItems.push({ name: bareAmount.head, amount: bareAmount.amount });
      return true;
    }

    return false;
  }

  function parseAssignmentHintLine(line, state) {
    const allMatch = line.match(/^(.*?)\s+(?:for all|shared by all|buat semua|untuk semua)$/i);
    if (allMatch) {
      state.itemHints.push({ name: allMatch[1].trim(), assignedTo: 'all' });
      return true;
    }

    const sharedMatch = line.match(/^(.+?)\s+(?:shared|share|patungan|bareng|berbagi)\s+(.+)$/i);
    if (sharedMatch) {
      const names = parseNamedList(sharedMatch[1]);
      state.people.push.apply(state.people, names);
      state.itemHints.push({ name: sharedMatch[2].trim(), assignedTo: names });
      return true;
    }

    const singleMatch = line.match(/^(.+?)\s+(?:had|ate|ordered|got|makan|pesan|ambil)\s+(.+)$/i);
    if (singleMatch) {
      const person = singleMatch[1].trim();
      state.people.push(person);
      state.itemHints.push({ name: singleMatch[2].trim(), assignedTo: [person] });
      return true;
    }
    return false;
  }

  function parseReceiptItemLine(line, state) {
    if (/^(?:subtotal|sub total|grand total|total|jumlah|amount due|balance due)\b/i.test(line)) return false;
    const amountInfo = extractTrailingAmount(line);
    if (!amountInfo) return false;
    if (/^(?:subtotal|sub total|grand total|total|jumlah|amount due|balance due)\b/i.test(amountInfo.head)) return false;
    state.receiptItems.push({ name: amountInfo.head, amount: amountInfo.amount });
    return true;
  }

  function finalizeNarrativeItems(items, pendingItems, people, splitEqually, assumptions) {
    const output = items.map(function (item) {
      return {
        name: item.name,
        amount: item.amount,
        assignedTo: item.assignedTo === 'all' ? people.slice() : item.assignedTo
      };
    });

    if (!pendingItems.length) {
      return output;
    }

    if (!people.length) {
      pendingItems.forEach(function (item) {
        output.push({ name: item.name, amount: item.amount, assignedTo: undefined });
      });
      return output;
    }

    if (people.length === 1) {
      pendingItems.forEach(function (item) {
        output.push({ name: item.name, amount: item.amount, assignedTo: [people[0]] });
      });
      return output;
    }

    if (splitEqually) {
      pendingItems.forEach(function (item) {
        assumptions.push(`'${item.name}' was shared across all listed people because the bill was marked for equal split.`);
        output.push({ name: item.name, amount: item.amount, assignedTo: people.slice() });
      });
      return output;
    }

    pendingItems.forEach(function (item) {
      output.push({ name: item.name, amount: item.amount, assignedTo: undefined });
    });
    return output;
  }

  function applyReceiptItems(receiptItems, itemHints, people, assumptions) {
    return receiptItems.map(function (item) {
      const hint = findMatchingHint(item.name, itemHints || []);
      if (hint) {
        return {
          name: item.name,
          amount: item.amount,
          assignedTo: hint.assignedTo === 'all' ? people.slice() : hint.assignedTo
        };
      }
      if (people.length) {
        assumptions.push(`'${item.name}' was shared across all listed people because no assignee was provided.`);
        return {
          name: item.name,
          amount: item.amount,
          assignedTo: people.slice()
        };
      }
      return {
        name: item.name,
        amount: item.amount,
        assignedTo: undefined
      };
    });
  }

  function findMatchingHint(name, hints) {
    const key = normalizeKey(name);
    for (const hint of hints) {
      const hintKey = normalizeKey(hint.name);
      if (hintKey === key || hintKey.includes(key) || key.includes(hintKey)) {
        return hint;
      }
    }
    return null;
  }

  function normalizeItems(items, people, scale, assumptions) {
    const peopleSet = new Set(people.map(function (name) { return String(name).toLowerCase(); }));
    return items.map(function (item, index) {
      if (!item || typeof item !== 'object') throw new Error(`items[${index}] must be an object`);
      const name = String(item.name || '').trim() || `Item ${index + 1}`;
      const amountUnits = toUnits(item.amount, scale, `items[${index}].amount`);
      let assignedTo = Array.isArray(item.assignedTo) && item.assignedTo.length ? uniqueStrings(item.assignedTo) : [];
      if (!assignedTo.length && people.length) {
        assumptions.push(`'${name}' was shared across all listed people because no assignee was provided.`);
        assignedTo = people.slice();
      }
      if (!assignedTo.length) {
        throw new Error(`I still need assignees for '${name}'.`);
      }
      assignedTo.forEach(function (person) {
        if (!peopleSet.has(String(person).toLowerCase())) {
          throw new Error(`items[${index}].assignedTo contains unknown person: ${person}`);
        }
      });
      return { name: name, amountUnits: amountUnits, assignedTo: assignedTo };
    });
  }

  function normalizePayments(payments, paidBy, people, scale) {
    const peopleSet = new Set(people);
    if (paidBy && payments && payments.length) {
      throw new Error('Use either paidBy or payments, not both.');
    }
    if (paidBy) {
      if (!peopleSet.has(paidBy)) {
        throw new Error(`paidBy contains unknown person: ${paidBy}`);
      }
      return [{ person: paidBy, amountUnits: null }];
    }
    if (!Array.isArray(payments) || !payments.length) return [];
    const merged = new Map();
    payments.forEach(function (payment) {
      if (!payment || typeof payment !== 'object') throw new Error('payments entries must be objects');
      if (!peopleSet.has(payment.person)) throw new Error(`payments contains unknown person: ${payment.person}`);
      const amountUnits = toUnits(payment.amount, scale, 'payments.amount');
      merged.set(payment.person, (merged.get(payment.person) || 0) + amountUnits);
    });
    return Array.from(merged.entries()).map(function (entry) {
      return { person: entry[0], amountUnits: entry[1] };
    });
  }

  function materializePayments(payments, paidBy, people, grandTotalUnits) {
    if (paidBy) {
      return [{ person: paidBy, amountUnits: grandTotalUnits }];
    }
    return (payments || []).map(function (payment) { return { person: payment.person, amountUnits: payment.amountUnits }; });
  }

  function settleBalances(rows) {
    const creditors = rows.filter(function (row) { return row.netUnits > 0; }).map(function (row) { return { name: row.name, amountUnits: row.netUnits }; });
    const debtors = rows.filter(function (row) { return row.netUnits < 0; }).map(function (row) { return { name: row.name, amountUnits: -row.netUnits }; });
    const settlements = [];
    let creditorIndex = 0;
    let debtorIndex = 0;
    while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
      const creditor = creditors[creditorIndex];
      const debtor = debtors[debtorIndex];
      const transfer = Math.min(creditor.amountUnits, debtor.amountUnits);
      if (transfer > 0) {
        settlements.push({ from: debtor.name, to: creditor.name, amountUnits: transfer });
      }
      creditor.amountUnits -= transfer;
      debtor.amountUnits -= transfer;
      if (creditor.amountUnits === 0) creditorIndex += 1;
      if (debtor.amountUnits === 0) debtorIndex += 1;
    }
    return settlements;
  }

  function buildRoundedOutputs(rows, settlements, incrementUnits, grandTotalUnits) {
    const roundedPerPerson = roundListWithBalancer(rows.map(function (row) {
      return { key: row.name, amountUnits: row.totalUnits };
    }), incrementUnits);
    const roundedSettlements = settlements.length
      ? roundListWithBalancer(settlements.map(function (settlement, index) {
          return { key: index, amountUnits: settlement.amountUnits };
        }), incrementUnits)
      : [];
    return { incrementUnits: incrementUnits, roundedPerPerson: roundedPerPerson, roundedSettlements: roundedSettlements };
  }

  function roundListWithBalancer(items, incrementUnits) {
    if (!items.length || incrementUnits <= 0) return [];
    const totalUnits = items.reduce(function (sum, item) { return sum + item.amountUnits; }, 0);
    const balancingIndex = items.reduce(function (best, item, index, list) {
      return list[index].amountUnits > list[best].amountUnits ? index : best;
    }, 0);
    const rounded = items.map(function (item, index) {
      return {
        key: item.key,
        exactUnits: item.amountUnits,
        roundedUnits: index === balancingIndex ? null : Math.max(0, Math.round(item.amountUnits / incrementUnits) * incrementUnits),
        balancing: index === balancingIndex
      };
    });
    const nonBalancingTotal = rounded.reduce(function (sum, item) { return sum + (item.roundedUnits || 0); }, 0);
    rounded[balancingIndex].roundedUnits = Math.max(0, totalUnits - nonBalancingTotal);
    return rounded;
  }

  function serializeRounded(rounded, scale) {
    return {
      increment: fromUnits(rounded.incrementUnits, scale),
      perPerson: rounded.roundedPerPerson.map(function (entry) {
        return {
          key: entry.key,
          exact: fromUnits(entry.exactUnits, scale),
          rounded: fromUnits(entry.roundedUnits, scale),
          balancing: entry.balancing
        };
      }),
      settlements: rounded.roundedSettlements.map(function (entry) {
        return {
          key: entry.key,
          exact: fromUnits(entry.exactUnits, scale),
          rounded: fromUnits(entry.roundedUnits, scale),
          balancing: entry.balancing
        };
      })
    };
  }

  function getReceiptImageSource(input) {
    const dataUrl = firstNonEmpty(input.receiptImageDataUrl, input.imageDataUrl, input.billImageDataUrl);
    if (dataUrl) return dataUrl;

    const base64 = firstNonEmpty(input.receiptImageBase64, input.imageBase64, input.billImageBase64);
    if (base64) {
      if (/^data:/i.test(base64)) return base64;
      const mimeType = firstNonEmpty(input.receiptImageMimeType, input.imageMimeType, 'image/png') || 'image/png';
      return 'data:' + mimeType + ';base64,' + String(base64).trim();
    }

    return firstNonEmpty(input.receiptImageUrl, input.imageUrl, input.billImageUrl);
  }

  async function extractReceiptTextFromImage(imageSource) {
    const Tesseract = await ensureTesseract();
    let result;
    try {
      result = await Tesseract.recognize(imageSource, 'eng+ind', { logger: function () {} });
    } catch (_error) {
      result = await Tesseract.recognize(imageSource, 'eng', { logger: function () {} });
    }
    const text = normalizeOcrText(result && result.data ? result.data.text : result && result.text ? result.text : '');
    if (!text) {
      throw new Error('OCR could not read any receipt text from the image.');
    }
    return text;
  }

  async function ensureTesseract() {
    if (root.Tesseract) return root.Tesseract;
    if (typeof document === 'undefined') {
      throw new Error('OCR image input needs the browser runtime. Pass ocrText or receiptText instead.');
    }
    if (!root.__splitBillsTesseractPromise) {
      root.__splitBillsTesseractPromise = loadScriptOnce('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js').then(function () {
        if (!root.Tesseract) {
          throw new Error('OCR library failed to load.');
        }
        return root.Tesseract;
      });
    }
    return root.__splitBillsTesseractPromise;
  }

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      const existing = Array.prototype.slice.call(document.getElementsByTagName('script')).find(function (script) {
        return script && script.src === src;
      });
      if (existing) {
        if (root.Tesseract) {
          resolve();
          return;
        }
        existing.addEventListener('load', function () { resolve(); }, { once: true });
        existing.addEventListener('error', function () { reject(new Error('Failed to load OCR library.')); }, { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('Failed to load OCR library.')); };
      document.head.appendChild(script);
    });
  }

  function normalizeOcrText(text) {
    return String(text || '')
      .replace(/\r/g, '\n')
      .split('\n')
      .map(function (line) {
        return String(line || '').replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean)
      .join('\n');
  }


  function followUp(language, message, breakdown) {
    return {
      needsFollowUp: true,
      message: message,
      breakdown: Object.assign({ language: language }, breakdown || {})
    };
  }

  function buildParsingBreakdown(textParsed, receiptParsed, assumptions, warnings) {
    return {
      textItems: textParsed.items,
      textItemHints: textParsed.itemHints,
      receiptItems: receiptParsed.receiptItems,
      assumptions: assumptions,
      warnings: warnings
    };
  }

  function emptyParsed() {
    return {
      people: [],
      items: [],
      itemHints: [],
      pendingItems: [],
      receiptItems: [],
      payments: [],
      paidBy: null,
      currency: null,
      taxPercent: undefined,
      taxAmount: undefined,
      tipPercent: undefined,
      tipAmount: undefined,
      discountPercent: undefined,
      discountAmount: undefined,
      servicePercent: undefined,
      serviceAmount: undefined,
      rounding: undefined,
      splitEqually: false,
      warnings: []
    };
  }

  function splitFacts(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/([!?])\s+/g, '$1\n')
      .replace(/(?<!\d)\.\s+/g, '.\n')
      .split(/\n|;/)
      .map(cleanLine)
      .filter(Boolean);
  }

  function cleanLine(line) {
    return String(line || '')
      .replace(/^\s*[-*•\d.)]+\s*/, '')
      .replace(/\s+/g, ' ')
      .replace(/[.!?]+$/, '')
      .trim();
  }

  function detectLanguage(text) {
    return ID_LANGUAGE_HINTS.test(String(text || '')) ? 'id' : 'en';
  }

  function parseNamedList(value) {
    return String(value || '').split(/,|\band\b|\bdan\b|&/i).map(function (part) { return part.trim(); }).filter(Boolean);
  }

  function normalizeKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).map(function (value) { return String(value || '').trim(); }).filter(Boolean)));
  }

  function normalizeCurrency(value) {
    const currency = String(value || 'IDR').trim().toUpperCase();
    if (!SUPPORTED_CURRENCIES.has(currency)) throw new Error(`unsupported currency: ${currency}`);
    return currency;
  }

  function getScaleForCurrency(currency) {
    return WHOLE_UNIT_CURRENCIES.has(currency) ? 1 : 100;
  }

  function parseNumberToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return null;
    let value = raw.replace(/rp/gi, '').replace(/idr/gi, '').replace(/,/g, '.').replace(/\s+/g, '');
    let multiplier = 1;
    if (/k$/i.test(value)) {
      multiplier = 1000;
      value = value.slice(0, -1);
    }
    if (/^\d{1,3}(\.\d{3})+(\.\d+)?$/.test(value)) {
      const lastDot = value.lastIndexOf('.');
      const decimals = value.length - lastDot - 1;
      if (decimals === 3 || /^\d{1,3}(\.\d{3})+$/.test(value)) {
        value = value.replace(/\./g, '');
      } else if (decimals > 0) {
        value = value.slice(0, lastDot).replace(/\./g, '') + '.' + value.slice(lastDot + 1);
      }
    }
    const number = Number(value);
    return Number.isFinite(number) ? number * multiplier : null;
  }

  function extractTrailingAmount(line) {
    const match = String(line || '').match(/^(.*?)(?:\s+|^)((?:rp\s*)?\d[\d.,]*(?:k)?)$/i);
    if (!match) return null;
    const amount = parseNumberToken(match[2]);
    if (amount === null) return null;
    return { head: match[1].trim(), amount: amount };
  }

  function parsePercentLine(line, keywords) {
    const pattern = new RegExp(`^(?:${keywords.join('|')})\\s*:?\\s*((?:\\d[\\d.,]*))\\s*%$`, 'i');
    const match = String(line || '').match(pattern);
    if (!match) return null;
    return parseNumberToken(match[1]);
  }

  function parseAmountLine(line, keywords) {
    const pattern = new RegExp(`^(?:${keywords.join('|')})\\s*:?\\s*((?:rp\\s*)?\\d[\\d.,]*(?:k)?)$`, 'i');
    const match = String(line || '').match(pattern);
    if (!match) return null;
    return parseNumberToken(match[1]);
  }

  function firstNonEmpty() {
    for (let i = 0; i < arguments.length; i += 1) {
      const value = arguments[i];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  }

  function firstDefined() {
    for (let i = 0; i < arguments.length; i += 1) {
      const value = arguments[i];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function normalizePercent(value, fieldName) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${fieldName} must be a valid non-negative number`);
    return number;
  }

  function normalizeRounding(value, scale) {
    if (!value) return 0;
    const numeric = typeof value === 'number' ? value : parseNumberToken(value);
    return numeric ? toUnits(numeric, scale, 'rounding') : 0;
  }

  function toUnits(value, scale, fieldName) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${fieldName} must be a valid non-negative number`);
    return Math.round(number * scale);
  }

  function fromUnits(units, scale) {
    return units / scale;
  }

  function percentToUnits(amountUnits, percent) {
    return Math.round((amountUnits * percent) / 100);
  }

  function splitAmountExactly(amountUnits, assignees) {
    const base = Math.floor(amountUnits / assignees.length);
    let remainder = amountUnits % assignees.length;
    return assignees.map(function (person) {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      return { person: person, amountUnits: base + extra };
    });
  }

  function allocateProportionally(totalUnits, weights) {
    if (totalUnits === 0) return weights.map(function () { return 0; });
    const sumWeights = weights.reduce(function (sum, weight) { return sum + weight; }, 0);
    if (sumWeights === 0) return weights.map(function (_, index) { return index === 0 ? totalUnits : 0; });
    const exacts = weights.map(function (weight) { return (weight * totalUnits) / sumWeights; });
    const floors = exacts.map(function (value) { return Math.floor(value); });
    let remainder = totalUnits - floors.reduce(function (sum, value) { return sum + value; }, 0);
    const ranked = exacts.map(function (value, index) {
      return { index: index, fraction: value - Math.floor(value) };
    }).sort(function (a, b) {
      return (b.fraction - a.fraction) || (a.index - b.index);
    });
    for (let i = 0; i < ranked.length && remainder > 0; i += 1) {
      floors[ranked[i].index] += 1;
      remainder -= 1;
    }
    return floors;
  }

  function formatMoney(amountUnits, currency, scale) {
    const value = amountUnits / scale;
    if (currency === 'IDR') {
      return 'Rp' + new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
    }
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: scale === 1 ? 0 : 2,
      maximumFractionDigits: scale === 1 ? 0 : 2
    }).format(value);
  }

  function formatPercentSuffix(percent) {
    return percent > 0 ? ' (' + trimPercent(percent) + '%)' : '';
  }

  function trimPercent(value) {
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  const api = { run: run };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.SplitBillsV3 = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
