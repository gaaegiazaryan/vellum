export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCurrencyError extends DomainError {
  constructor(readonly value: string) {
    super(`invalid currency code: ${JSON.stringify(value)}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`currency mismatch: ${left} vs ${right}`);
  }
}

export class EntryTooSmallError extends DomainError {
  constructor(readonly lineCount: number) {
    super(`journal entry requires at least 2 lines, got ${lineCount}`);
  }
}

export class MixedCurrencyEntryError extends DomainError {
  constructor(readonly currencies: ReadonlyArray<string>) {
    super(`journal entry mixes currencies: ${currencies.join(', ')}`);
  }
}

export class UnbalancedEntryError extends DomainError {
  constructor(
    readonly debitTotal: bigint,
    readonly creditTotal: bigint,
  ) {
    super(`journal entry is unbalanced: debits=${debitTotal}, credits=${creditTotal}`);
  }
}

export class NegativeLedgerAmountError extends DomainError {
  constructor(readonly amount: bigint) {
    super(`ledger line amount must be non-negative, got ${amount}`);
  }
}
