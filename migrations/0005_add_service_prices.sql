ALTER TABLE services ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0;

UPDATE services
SET price_cents = 7500
WHERE code = '60';

UPDATE services
SET price_cents = 9900
WHERE code = '90';

UPDATE services
SET price_cents = 12900
WHERE code = '120';
