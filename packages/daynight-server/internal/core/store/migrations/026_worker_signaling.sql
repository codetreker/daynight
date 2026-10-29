ALTER TABLE tasks ADD COLUMN worker_needs_attention boolean NOT NULL DEFAULT false;

-- Keep opaque JSON string escapes intact, including permitted NUL and lone
-- surrogates in PR properties. The strict stored format has one root worker key.
UPDATE tasks
SET properties = regexp_replace(
    properties,
    $pattern$(?<!\\)"worker"[[:space:]]*:[[:space:]]*\{$pattern$,
    $replacement$\&"signaling":"",$replacement$
)
WHERE properties ~ $pattern$(?<!\\)"worker"[[:space:]]*:[[:space:]]*\{$pattern$;
