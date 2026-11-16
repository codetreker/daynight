-- Preserve the writer identity and owner while removing the obsolete byte quota.
UPDATE image_runtime_state
SET value = json_remove(value, '$.maximumBytes')
WHERE key = 'native_index_reservation'
  AND CASE WHEN json_valid(value) THEN
    json_type(value) = 'object' AND json_type(value, '$.maximumBytes') IS NOT NULL
  ELSE 0 END;
