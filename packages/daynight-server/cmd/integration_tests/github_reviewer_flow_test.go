//go:build integration

package main

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func verifyGitHubReviewerAllocation(t *testing.T, f *fixture, projectID, base string) api.PullRequestReviewer {
	t.Helper()
	read := func() api.PullRequestDetail {
		t.Helper()
		return requestJSON[api.PullRequestDetail](t, f, http.MethodGet, base+"/pull-requests/1", nil, http.StatusOK)
	}
	if detail := read(); detail.Reviewer != nil {
		t.Fatalf("unconfigured project has a reviewer: %+v", detail.Reviewer)
	}

	db, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	workerID := uuid.NewString()
	config := fmt.Sprintf(`{"projects":[{"projectId":%q}]}`, projectID)
	_, err = db.Exec(f.context, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration)
		VALUES($1,$2,now(),now(),'{}','{}',1,now(),$3)`, f.userID, workerID, config)
	if err != nil {
		t.Fatal(err)
	}
	settingsPath := "/api/v1/me/workers/" + workerID + "/review-settings"
	requestJSON[map[string]bool](t, f, http.MethodPut, settingsPath, map[string]bool{"enabled": true}, http.StatusOK)

	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(100 * time.Millisecond)
	defer poll.Stop()
	for {
		if reviewer := read().Reviewer; reviewer != nil {
			if reviewer.UserID != f.userID || reviewer.WorkerID != workerID || reviewer.AssignedAt.IsZero() {
				t.Fatalf("unexpected reviewer: %+v", reviewer)
			}
			return *reviewer
		}
		select {
		case <-deadline.C:
			t.Fatal("synced Open PR was not assigned after Worker enabled review")
		case <-poll.C:
		}
	}
}
