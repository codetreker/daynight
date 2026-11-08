package server

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestWorkerReportHTTPActiveLimit(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	ctx := context.Background()
	id := uuid.NewString()
	body := workerSnapshotReportBody()
	reportSnapshotHTTP(t, handler, id, body)
	if _, err := database.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
		SELECT user_id,gen_random_uuid(),created_at,last_seen_at,telemetry,task_snapshot FROM workers CROSS JOIN generate_series(1,99)
		WHERE user_id=$1 AND worker_id=$2`, handler.principal.UserID, id); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := database.Pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w WHERE user_id=$1`, handler.principal.UserID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodPost, "/api/v1/me/workers/"+uuid.NewString()+"/report", jsonBody(t, body))
	assertProjectError(t, response, http.StatusConflict, "active_worker_limit_exceeded")
	var after string
	if err := database.Pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w WHERE user_id=$1`, handler.principal.UserID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("refused HTTP report changed worker rows")
	}
	reportSnapshotHTTP(t, handler, id, body)
}
