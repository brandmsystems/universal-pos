ALTER TABLE platform.invoice
  DROP CONSTRAINT IF EXISTS invoice_void_consistent,
  DROP CONSTRAINT IF EXISTS invoice_void_credit_note_fk;
DROP TABLE IF EXISTS platform.credit_note;

DROP TRIGGER IF EXISTS invoice_line_is_immutable ON platform.invoice_line;
DROP FUNCTION IF EXISTS platform.deny_invoice_line_rewrite();
DROP TRIGGER IF EXISTS invoice_is_immutable ON platform.invoice;
DROP FUNCTION IF EXISTS platform.deny_issued_invoice_rewrite();
DROP TRIGGER IF EXISTS invoice_tax_component_consistent ON platform.invoice_tax_component;
DROP TRIGGER IF EXISTS invoice_line_consistent ON platform.invoice_line;
DROP FUNCTION IF EXISTS platform.assert_invoice_consistent();

DROP TABLE IF EXISTS platform.invoice_tax_component;
DROP TABLE IF EXISTS platform.invoice_line;
ALTER TABLE platform.subscription_segment
  DROP CONSTRAINT IF EXISTS subscription_segment_invoice_fk;
DROP TABLE IF EXISTS platform.invoice;
DROP TABLE IF EXISTS platform.scheduled_subscription_change;
DROP TABLE IF EXISTS platform.subscription_segment;

DROP FUNCTION IF EXISTS platform.next_document_no(uuid, text, text);
DROP TABLE IF EXISTS platform.document_sequence;
DROP FUNCTION IF EXISTS platform.financial_year_label(date, smallint);

DROP TRIGGER IF EXISTS tenant_tax_profile_exemption_guard ON platform.tenant_tax_profile;
DROP FUNCTION IF EXISTS platform.guard_tax_exemption();
DROP TRIGGER IF EXISTS tenant_tax_profile_set_updated_at ON platform.tenant_tax_profile;
DROP TABLE IF EXISTS platform.tenant_tax_profile;
DROP TABLE IF EXISTS platform.supplier_gst_registration;
