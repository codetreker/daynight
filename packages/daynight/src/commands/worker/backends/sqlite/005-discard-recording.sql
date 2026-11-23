-- Existing terminal and shutdown records did not select recording deletion.
UPDATE executions SET data = json_set(data, '$.cleanup.discardRecording', json('false'))
WHERE json_type(data, '$.cleanup') = 'object'
  AND json_type(data, '$.cleanup.discardRecording') IS NULL;
