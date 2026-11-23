package bot

import (
	"context"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

// BotObservation reads only the current host and bound Session metadata. Worker
// inventory expiry and activity belonging to other tasks do not affect this read.
func (s *Reader) BotObservation(ctx context.Context, ownerID, botID string) (store.BotObservationSource, error) {
	var source store.BotObservationSource
	var workerID, sessionID, instance *string
	var lastReported *time.Time
	var telemetry, snapshot []byte
	session := &store.BotSessionSource{}
	err := s.tx.QueryRow(ctx, `SELECT w.worker_id::text,w.last_seen_at,
 CASE WHEN w.worker_id IS NOT NULL THEN jsonb_build_object(
  'machine',w.telemetry->'machine','platform',w.telemetry->'platform','assistantHost',w.telemetry->'assistantHost') END,
 s.id::text,
 CASE WHEN s.id IS NOT NULL THEN jsonb_build_object(
  'sessionId',s.snapshot->'sessionId','testExecutionId',s.snapshot->'testExecutionId',
  'claimId',s.snapshot->'claimId','executionGeneration',s.snapshot->'executionGeneration',
  'connectionEpoch',s.snapshot->'connectionEpoch','identity',s.snapshot->'identity','lifecycle',s.snapshot->'lifecycle') END,
 s.last_seen,s.connection_expires_at,s.server_instance::text
 FROM bots b
 LEFT JOIN bot_recovery r ON r.bot_id=b.id
 LEFT JOIN workers w ON w.user_id=b.owner_user_id AND w.worker_id=COALESCE(r.worker_id,b.worker_id)
 LEFT JOIN task_sessions s ON s.id=b.session_id AND s.bot_id=b.id AND s.owner_user_id=b.owner_user_id
 WHERE b.id=$1 AND b.owner_user_id=$2 AND b.deletion IS NULL`, botID, ownerID).Scan(
		&workerID, &lastReported, &telemetry, &sessionID, &snapshot,
		&session.LastSeen, &session.ConnectionExpiry, &instance)
	if err != nil {
		return source, pg.QueryError("read bot observation", err)
	}
	if workerID != nil {
		worker := &model.WorkerSnapshot{UserID: ownerID, WorkerID: *workerID, LastReportedAt: lastReported.UTC()}
		if err := json.Unmarshal(telemetry, &worker.Telemetry); err != nil {
			return source, pg.QueryError("decode bot observation worker", err)
		}
		source.Worker = worker
	}
	if sessionID != nil {
		if err := json.Unmarshal(snapshot, &session.Snapshot); err != nil {
			return store.BotObservationSource{}, pg.QueryError("decode bot observation session", err)
		}
		if instance != nil {
			session.ServerInstance = *instance
		}
		if session.LastSeen != nil {
			stamp := session.LastSeen.UTC()
			session.LastSeen = &stamp
		}
		if session.ConnectionExpiry != nil {
			stamp := session.ConnectionExpiry.UTC()
			session.ConnectionExpiry = &stamp
		}
		source.Session = session
	}
	return source, nil
}
