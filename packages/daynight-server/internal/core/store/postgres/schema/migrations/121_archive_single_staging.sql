-- Prevent the old numbered-block v2 format from being interpreted as a single file.
-- Hold the table lock through the schema change and migration receipt.
LOCK TABLE session_archive_files IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM session_archive_files WHERE upload_version = 2) THEN
  RAISE EXCEPTION 'numbered-block archive v2 records require the previous environment';
 END IF;
END $$;
ALTER TABLE session_archive_files DROP COLUMN prefix_proof;
