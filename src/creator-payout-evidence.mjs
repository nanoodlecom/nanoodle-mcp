function account(value) {
  return typeof value === "string" ? value.replace(/^xrb_/, "nano_") : null;
}

export function sameCreatorDestination(expected, record) {
  return expected.to === undefined || (account(expected.to) !== null && account(expected.to) === account(record.to));
}

export function sameCreatorPayout(expected, record) {
  return sameCreatorDestination(expected, record) && expected.amountRaw === record.amountRaw;
}

export function marketCreatorPayoutTerms(record) {
  const creator = record?.creator;
  if (!creator || !["owed", "queued"].includes(creator.status)) return null;
  return { to: creator.author, amountRaw: creator.amountRaw };
}
