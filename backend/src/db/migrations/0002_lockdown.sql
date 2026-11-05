-- Defence in depth on Supabase. The API connects as the database owner, so
-- none of this affects it; it only shuts out Supabase's client roles.
-- 1. Row-level security on every GoMax table, with no policies = deny all
--    to anon / authenticated (the table owner bypasses RLS).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'gomax' LOOP
    EXECUTE format('ALTER TABLE gomax.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint
-- 2. Supabase's REST/GraphQL roles get no access to the gomax schema at all
--    (skipped on plain Postgres, where these roles don't exist).
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA gomax FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA gomax FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA gomax FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA gomax REVOKE ALL ON TABLES FROM %I', r);
    END IF;
  END LOOP;
END $$;
