-- PostgreSQL JSON extraction decodes opaque PR escapes, including permitted
-- NUL and lone surrogates. Preserve the document bytes instead. The version-19
-- codec permits a worker key only at the root; quoted content escapes its
-- quotes, and a null worker does not match the opening object delimiter.
UPDATE tasks
SET properties = regexp_replace(
    properties,
    $pattern$(?<!\\)"worker"[[:space:]]*:[[:space:]]*\{$pattern$,
    $replacement$\&"agentControlMode":"herdr",$replacement$
)
WHERE properties ~ $pattern$(?<!\\)"worker"[[:space:]]*:[[:space:]]*\{$pattern$;
