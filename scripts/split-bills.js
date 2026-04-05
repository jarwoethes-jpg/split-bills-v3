(function () {
  function run(rawData) {
    const input = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    const currency = normalizeCurrency(input.currency || 'IDR');
    const scale = getScaleForCurrency(currency);
    const people = normalizePeople(input.people);
    const items = normalizeItems(input.items, people, scale);
    const taxPercent = normalizePercent(input.taxPercent || 0, 'taxPercent');
    const tipPercent = normalizePercent(input.tipPercent || 0, 'tipPercent');

    if (!items.length) {
      throw new Error('items must contain at least one item');
    }

    const personMap = new Map();
    for (const person of people) {
      personMap.set(person, {
        name: person,
        itemSubtotalUnits: 0,
        taxShareUnits: 0,
        tipShareUnits: 0,
        totalUnits: 0,
        paidUnits: 0,
        netUnits: 0,
        items: []
      });
    }

    let subtotalUnits = 0;
    for (const item of items) {
      subtotalUnits += item.amountUnits;
      const shares = splitAmountExactly(item.amountUnits, item.assignedTo);
      for (const share of shares) {
        const entry = personMap.get(share.person);
        entry.itemSubtotalUnits += share.amountUnits;
        entry.items.push({
          name: item.name,
          shareUnits: share.amountUnits,
          sharedWith: item.assignedTo.length > 1 ? [...item.assignedTo] : undefined
        });
      }
    }

    const taxAmountUnits = percentToUnits(subtotalUnits, taxPercent);
    const tipAmountUnits = percentToUnits(subtotalUnits, tipPercent);
    const grandTotalUnits = subtotalUnits + taxAmountUnits + tipAmountUnits;

    const weights = people.map((person) => personMap.get(person).itemSubtotalUnits);
    const taxAllocations = allocateProportionally(taxAmountUnits, weights);
    const tipAllocations = allocateProportionally(tipAmountUnits, weights);

    people.forEach((person, index) => {
      const entry = personMap.get(person);
      entry.taxShareUnits = taxAllocations[index];
      entry.tipShareUnits = tipAllocations[index];
      entry.totalUnits = entry.itemSubtotalUnits + entry.taxShareUnits + entry.tipShareUnits;
    });

    const payments = normalizePayments(input, people, grandTotalUnits, scale);
    for (const payment of payments) {
      personMap.get(payment.person).paidUnits += payment.amountUnits;
    }

    if (payments.length) {
      people.forEach((person) => {
        const entry = personMap.get(person);
        entry.netUnits = entry.paidUnits - entry.totalUnits;
      });
    } else {
      people.forEach((person) => {
        personMap.get(person).netUnits = 0;
      });
    }

    const settlements = payments.length ? settleBalances(people.map((person) => personMap.get(person))) : [];

    const perPerson = people.map((person) => {
      const entry = personMap.get(person);
      return {
        name: entry.name,
        itemSubtotal: fromUnits(entry.itemSubtotalUnits, scale),
        taxShare: fromUnits(entry.taxShareUnits, scale),
        tipShare: fromUnits(entry.tipShareUnits, scale),
        total: fromUnits(entry.totalUnits, scale),
        paid: fromUnits(entry.paidUnits, scale),
        net: fromUnits(entry.netUnits, scale),
        items: entry.items.map((item) => ({
          name: item.name,
          share: fromUnits(item.shareUnits, scale),
          sharedWith: item.sharedWith
        }))
      };
    });

    return {
      result: buildSummary({
        currency,
        subtotalUnits,
        taxPercent,
        taxAmountUnits,
        tipPercent,
        tipAmountUnits,
        grandTotalUnits,
        perPerson: people.map((person) => personMap.get(person)),
        settlements,
        scale
      }),
      breakdown: {
        currency,
        subtotal: fromUnits(subtotalUnits, scale),
        taxPercent,
        taxAmount: fromUnits(taxAmountUnits, scale),
        tipPercent,
        tipAmount: fromUnits(tipAmountUnits, scale),
        grandTotal: fromUnits(grandTotalUnits, scale),
        people: perPerson,
        items: items.map((item) => ({
          name: item.name,
          amount: fromUnits(item.amountUnits, scale),
          assignedTo: item.assignedTo
        })),
        payments: payments.map((payment) => ({
          person: payment.person,
          amount: fromUnits(payment.amountUnits, scale)
        })),
        settlements: settlements.map((settlement) => ({
          from: settlement.from,
          to: settlement.to,
          amount: fromUnits(settlement.amountUnits, scale)
        }))
      }
    };
  }

  function normalizePeople(value) {
    if (!Array.isArray(value) || !value.length) {
      throw new Error('people must be a non-empty array of names');
    }
    const cleaned = value.map((name) => String(name || '').trim()).filter(Boolean);
    const unique = [...new Set(cleaned)];
    if (!unique.length) {
      throw new Error('people must contain at least one valid name');
    }
    if (unique.length !== cleaned.length) {
      throw new Error('people must not contain duplicates');
    }
    return unique;
  }

  function normalizeItems(value, people, scale) {
    if (!Array.isArray(value)) {
      throw new Error('items must be an array');
    }
    const peopleSet = new Set(people);
    return value.map((item, index) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`items[${index}] must be an object`);
      }
      const name = String(item.name || '').trim() || `Item ${index + 1}`;
      const amountUnits = toUnits(item.amount, scale, `items[${index}].amount`);
      const assignedRaw = Array.isArray(item.assignedTo) && item.assignedTo.length ? item.assignedTo : people;
      const assignedTo = [...new Set(assignedRaw.map((name) => String(name || '').trim()).filter(Boolean))];
      if (!assignedTo.length) {
        throw new Error(`items[${index}].assignedTo must contain at least one person`);
      }
      for (const person of assignedTo) {
        if (!peopleSet.has(person)) {
          throw new Error(`items[${index}].assignedTo contains unknown person: ${person}`);
        }
      }
      return { name, amountUnits, assignedTo };
    });
  }

  function normalizePayments(input, people, grandTotalUnits, scale) {
    const peopleSet = new Set(people);
    const hasPaidBy = input.paidBy !== undefined && input.paidBy !== null && String(input.paidBy).trim() !== '';
    const hasPayments = Array.isArray(input.payments) && input.payments.length > 0;

    if (hasPaidBy && hasPayments) {
      throw new Error('use either paidBy or payments, not both');
    }

    let payments = [];
    if (hasPaidBy) {
      const payer = String(input.paidBy).trim();
      if (!peopleSet.has(payer)) {
        throw new Error(`paidBy contains unknown person: ${payer}`);
      }
      payments = [{ person: payer, amountUnits: grandTotalUnits }];
    } else if (hasPayments) {
      payments = input.payments.map((payment, index) => {
        if (!payment || typeof payment !== 'object') {
          throw new Error(`payments[${index}] must be an object`);
        }
        const person = String(payment.person || '').trim();
        if (!peopleSet.has(person)) {
          throw new Error(`payments[${index}].person contains unknown person: ${person}`);
        }
        const amountUnits = toUnits(payment.amount, scale, `payments[${index}].amount`);
        return { person, amountUnits };
      });
    }

    if (payments.length) {
      const merged = new Map();
      for (const payment of payments) {
        merged.set(payment.person, (merged.get(payment.person) || 0) + payment.amountUnits);
      }
      payments = Array.from(merged.entries()).map(([person, amountUnits]) => ({ person, amountUnits }));
      const paidTotal = payments.reduce((sum, payment) => sum + payment.amountUnits, 0);
      if (paidTotal !== grandTotalUnits) {
        throw new Error('payments must add up exactly to the grand total');
      }
    }

    return payments;
  }

  function normalizeCurrency(value) {
    const currency = String(value || 'IDR').trim().toUpperCase();
    const allowed = new Set(['IDR', 'USD', 'EUR', 'GBP', 'SGD', 'JPY', 'AUD', 'MYR']);
    if (!allowed.has(currency)) {
      throw new Error(`unsupported currency: ${currency}`);
    }
    return currency;
  }

  function getScaleForCurrency(currency) {
    return currency === 'IDR' || currency === 'JPY' ? 1 : 100;
  }

  function normalizePercent(value, fieldName) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`${fieldName} must be a valid non-negative number`);
    }
    return number;
  }

  function toUnits(value, scale, fieldName) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error(`${fieldName} must be a valid non-negative number`);
    }
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
    return assignees.map((person) => {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      return { person, amountUnits: base + extra };
    });
  }

  function allocateProportionally(totalUnits, weights) {
    if (totalUnits === 0) {
      return weights.map(() => 0);
    }
    const sumWeights = weights.reduce((sum, weight) => sum + weight, 0);
    if (sumWeights === 0) {
      return weights.map((_, index) => (index === 0 ? totalUnits : 0));
    }

    const exacts = weights.map((weight) => (weight * totalUnits) / sumWeights);
    const floors = exacts.map((value) => Math.floor(value));
    let remainder = totalUnits - floors.reduce((sum, value) => sum + value, 0);

    const ranked = exacts
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((a, b) => {
        if (b.fraction !== a.fraction) {
          return b.fraction - a.fraction;
        }
        return a.index - b.index;
      });

    for (let i = 0; i < ranked.length && remainder > 0; i += 1) {
      floors[ranked[i].index] += 1;
      remainder -= 1;
    }

    return floors;
  }

  function settleBalances(entries) {
    const creditors = entries
      .filter((entry) => entry.netUnits > 0)
      .map((entry) => ({ name: entry.name, amountUnits: entry.netUnits }));
    const debtors = entries
      .filter((entry) => entry.netUnits < 0)
      .map((entry) => ({ name: entry.name, amountUnits: -entry.netUnits }));

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
      if (creditor.amountUnits === 0) {
        creditorIndex += 1;
      }
      if (debtor.amountUnits === 0) {
        debtorIndex += 1;
      }
    }

    return settlements;
  }

  function buildSummary(data) {
    const lines = [];
    lines.push(`Subtotal: ${formatMoney(data.subtotalUnits, data.currency, data.scale)}`);
    if (data.taxAmountUnits > 0) {
      lines.push(`Tax (${trimPercent(data.taxPercent)}%): ${formatMoney(data.taxAmountUnits, data.currency, data.scale)}`);
    }
    if (data.tipAmountUnits > 0) {
      lines.push(`Tip (${trimPercent(data.tipPercent)}%): ${formatMoney(data.tipAmountUnits, data.currency, data.scale)}`);
    }
    lines.push(`Grand total: ${formatMoney(data.grandTotalUnits, data.currency, data.scale)}`);
    lines.push('');
    lines.push('Per person:');

    for (const person of data.perPerson) {
      let line = `- ${person.name}: ${formatMoney(person.totalUnits, data.currency, data.scale)}`;
      const parts = [`items ${formatMoney(person.itemSubtotalUnits, data.currency, data.scale)}`];
      if (person.taxShareUnits > 0) {
        parts.push(`tax ${formatMoney(person.taxShareUnits, data.currency, data.scale)}`);
      }
      if (person.tipShareUnits > 0) {
        parts.push(`tip ${formatMoney(person.tipShareUnits, data.currency, data.scale)}`);
      }
      if (person.paidUnits > 0) {
        parts.push(`paid ${formatMoney(person.paidUnits, data.currency, data.scale)}`);
        const label = person.netUnits >= 0 ? 'to receive' : 'owes';
        parts.push(`${label} ${formatMoney(Math.abs(person.netUnits), data.currency, data.scale)}`);
      }
      line += ` (${parts.join(', ')})`;
      lines.push(line);
    }

    if (data.settlements.length) {
      lines.push('');
      lines.push('Settlement:');
      for (const settlement of data.settlements) {
        lines.push(`- ${settlement.from} pays ${settlement.to} ${formatMoney(settlement.amountUnits, data.currency, data.scale)}`);
      }
    }

    return lines.join('\n');
  }

  function trimPercent(value) {
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function formatMoney(amountUnits, currency, scale) {
    const value = amountUnits / scale;
    if (currency === 'IDR') {
      return `Rp${new Intl.NumberFormat('id-ID', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
      }).format(value)}`;
    }
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: scale === 1 ? 0 : 2,
      maximumFractionDigits: scale === 1 ? 0 : 2
    }).format(value);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      run,
      _private: {
        allocateProportionally,
        splitAmountExactly,
        settleBalances,
        normalizePayments,
        getScaleForCurrency
      }
    };
  }

  if (typeof window !== 'undefined') {
    window.SplitBillsV3 = { run };
  }
})();
