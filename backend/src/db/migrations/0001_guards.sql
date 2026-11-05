-- Audit log is append-only (D9: kept 7 years, never edited).
CREATE OR REPLACE FUNCTION gomax.audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON gomax.audit_log
  FOR EACH ROW EXECUTE FUNCTION gomax.audit_log_append_only();
--> statement-breakpoint
-- Human-facing numbers: W-1001…, G-1001…
ALTER SEQUENCE gomax.withdrawals_id_seq RESTART WITH 1001;
--> statement-breakpoint
ALTER SEQUENCE gomax.gift_orders_id_seq RESTART WITH 1001;
