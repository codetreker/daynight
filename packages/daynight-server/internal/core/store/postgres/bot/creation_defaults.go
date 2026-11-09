package bot

import (
	"context"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Reader) BotPreferredWorker(ctx context.Context, ownerID string) (*string, error) {
	return readPreferredWorker(ctx, s.tx, ownerID)
}
func (b *Writer) BotPreferredWorker(ctx context.Context, ownerID string) (*string, error) {
	return readPreferredWorker(ctx, b.tx, ownerID)
}
func readPreferredWorker(ctx context.Context, tx pgx.Tx, ownerID string) (*string, error) {
	var id *string
	if err := tx.QueryRow(ctx, `SELECT (SELECT worker_id::text FROM bot_worker_preferences WHERE user_id=$1)`, ownerID).Scan(&id); err != nil {
		return nil, pg.QueryError("read bot worker preference", err)
	}
	return id, nil
}

func (s *Reader) BotCreationCandidate(ctx context.Context, ownerID, workerID string) (model.BotDefaultsInput, error) {
	return readCreationDefaults(ctx, s.tx, ownerID, &workerID, false)
}
func (b *Writer) BotCreationCandidate(ctx context.Context, ownerID, workerID string) (model.BotDefaultsInput, error) {
	return readCreationDefaults(ctx, b.tx, ownerID, &workerID, false)
}
func (s *Reader) BotCreationCandidates(ctx context.Context, ownerID string) (model.BotDefaultsInput, error) {
	return readCreationDefaults(ctx, s.tx, ownerID, nil, false)
}
func (b *Writer) BotCreationCandidates(ctx context.Context, ownerID string) (model.BotDefaultsInput, error) {
	return readCreationDefaults(ctx, b.tx, ownerID, nil, false)
}
func (s *Reader) BotCreationWorker(ctx context.Context, ownerID, workerID string) (model.BotDefaultsInput, error) {
	return readCreationDefaults(ctx, s.tx, ownerID, &workerID, true)
}
func (b *Writer) BotCreationWorker(ctx context.Context, ownerID, workerID string) (model.BotDefaultsInput, error) {
	return readCreationDefaults(ctx, b.tx, ownerID, &workerID, true)
}

// The candidate projection omits unrelated telemetry, task snapshots, and the
// potentially large provider arguments and runtime configuration. Selection
// still uses the core's ordinary availability and precedence rules.
const candidateTelemetry = `jsonb_build_object(
 'platform', w.telemetry->'platform',
 'assistantHost', CASE WHEN w.telemetry->'assistantHost' IS NULL OR w.telemetry->'assistantHost' = 'null'::jsonb THEN NULL ELSE
   ((w.telemetry->'assistantHost') - 'providers') || jsonb_build_object('providers',
     CASE WHEN jsonb_typeof(w.telemetry->'assistantHost'->'providers') = 'array' THEN
       COALESCE((SELECT jsonb_agg((expanded.value - 'model') - 'args') FROM jsonb_array_elements(w.telemetry->'assistantHost'->'providers') AS expanded(value)), '[]'::jsonb)
     ELSE w.telemetry->'assistantHost'->'providers' END)
 END)`

const selectedTelemetry = `jsonb_build_object('platform', w.telemetry->'platform', 'machine', w.telemetry->'machine',
 'assistantHost', w.telemetry->'assistantHost', 'runtimeConfiguration', w.telemetry->'runtimeConfiguration')`

func readCreationDefaults(ctx context.Context, tx pgx.Tx, ownerID string, workerID *string, selected bool) (model.BotDefaultsInput, error) {
	result := model.BotDefaultsInput{Workers: []model.WorkerSnapshot{}, WorkerPreferences: map[string]model.BotWorkerPreference{}}
	projection := candidateTelemetry
	if selected {
		projection = selectedTelemetry
	}
	// 101 permits the caller to reject an over-capacity historical set rather
	// than choosing from a truncated set. The normal admission maximum is 100.
	filter := `w.user_id=$1 AND w.last_seen_at > statement_timestamp() - interval '120 seconds' AND w.last_seen_at <= statement_timestamp()`
	args := []any{ownerID}
	if workerID != nil {
		filter = `w.user_id=$1 AND w.worker_id=$2`
		args = append(args, *workerID)
	}
	query := `SELECT w.worker_id::text,w.created_at,w.last_seen_at,` + projection + `,p.cwd,p.provider
 FROM (SELECT * FROM workers w WHERE ` + filter + ` ORDER BY w.created_at,w.worker_id LIMIT 101) w
 LEFT JOIN bot_configuration_preferences p ON p.user_id=w.user_id AND p.worker_id=w.worker_id
 ORDER BY w.created_at,w.worker_id`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return model.BotDefaultsInput{}, pg.QueryError("read bot creation workers", err)
	}
	for rows.Next() {
		var worker model.WorkerSnapshot
		var telemetry []byte
		var preference model.BotWorkerPreference
		if err := rows.Scan(&worker.WorkerID, &worker.CreatedAt, &worker.LastReportedAt, &telemetry, &preference.Cwd, &preference.Provider); err != nil {
			rows.Close()
			return model.BotDefaultsInput{}, pg.QueryError("read bot creation workers", err)
		}
		if err := json.Unmarshal(telemetry, &worker.Telemetry); err != nil {
			rows.Close()
			return model.BotDefaultsInput{}, pg.QueryError("read bot creation workers", err)
		}
		worker.UserID = ownerID
		worker.CreatedAt, worker.LastReportedAt = worker.CreatedAt.UTC(), worker.LastReportedAt.UTC()
		result.Workers = append(result.Workers, worker)
		result.WorkerPreferences[worker.WorkerID] = preference
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return model.BotDefaultsInput{}, pg.QueryError("read bot creation workers", err)
	}
	if selected && len(result.Workers) != 0 {
		if err := readNativePreferencesForWorker(ctx, tx, ownerID, *workerID, result.WorkerPreferences); err != nil {
			return model.BotDefaultsInput{}, err
		}
	}
	// Sample after all reads so a heartbeat observed by a ReadCommitted query is
	// never classified as future relative to a clock sampled before that query.
	if err := tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&result.ObservedAt); err != nil {
		return model.BotDefaultsInput{}, pg.QueryError("read bot default observation", err)
	}
	result.ObservedAt = result.ObservedAt.UTC()
	return result, nil
}
