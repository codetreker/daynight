CREATE INDEX team_members_team_created
ON team_members USING btree (team_id, created_at);

CREATE INDEX session_operations_terminal_pending
ON session_operations USING btree (session_id, operation_seq)
WHERE receipt->>'state' IN ('queued', 'dispatching');
