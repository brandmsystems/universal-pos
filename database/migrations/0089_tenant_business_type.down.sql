-- Drops the classification. It records configuration, not an event: what a
-- tenant sold, billed and was paid is in app.* and is untouched. A tenant that
-- had been moved off 'restaurant' reads as a restaurant again after this.
ALTER TABLE platform.tenant DROP COLUMN business_type;
