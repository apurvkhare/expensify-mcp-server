-- Expensify: one table, one index. Amounts are rupees with two decimals.
-- Real systems store minor units (paise); the demo keeps it readable.
CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT PRIMARY KEY,
  amount      REAL NOT NULL CHECK (amount > 0),
  currency    TEXT NOT NULL DEFAULT 'INR',
  category    TEXT NOT NULL CHECK (category IN ('food','travel','software','office','health','other')),
  merchant    TEXT NOT NULL,
  date        TEXT NOT NULL,
  note        TEXT,
  created_by  TEXT NOT NULL DEFAULT 'apurv',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses (date);
CREATE INDEX IF NOT EXISTS idx_expenses_merchant ON expenses (merchant);
