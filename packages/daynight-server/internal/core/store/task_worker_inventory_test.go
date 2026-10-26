package store

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func TestWorkerInventoryReadsOpaquePropertiesWithoutPostgresJSONConversion(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	owner, workerID := queryID(2), queryID(3)
	for number := 10; number < 14; number++ {
		queryTask(t, database, project.ID, number, core.TaskInProgress)
		claim := &core.WorkerClaim{ClaimID: queryID(number + 100), State: core.WorkerActive, UserID: owner, WorkerID: workerID,
			Machine: core.WorkerMachine{ID: queryID(4), Name: "Machine"}, Platform: core.PlatformLinux, Agent: core.AgentCodex, WorktreeID: queryID(number + 200), Phase: core.WorkerPreparing, ClaimedAt: time.Now().UTC()}
		if number < 12 {
			claim.UserID = queryID(5)
		}
		properties := taskproperties.Encode(core.TaskProperties{PullRequests: []core.PullRequestProperty{}, Worker: claim})
		properties = strings.Replace(properties, `"pullRequests":[]`, `"pullRequests":[{"url":"\u0000","title":"\ud800"}]`, 1)
		mustQueryExec(t, database, `UPDATE tasks SET properties=$2 WHERE id=$1`, queryID(number), properties)
	}
	query := TaskQuery{Page: Page{Limit: 1}, Worker: &WorkerQuery{UserID: owner, WorkerID: workerID}}
	for _, number := range []int{12, 13} {
		var page TaskPage
		err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
			var err error
			page, err = snapshot.Tasks(context.Background(), project.ID, query)
			return err
		})
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != queryID(number) || page.HasMore != (number == 12) {
			t.Fatalf("opaque ownership page %d: %#v, %v", number, page, err)
		}
		if page.Items[0].Properties.PullRequests[0].URL != "\x00" {
			t.Fatal("opaque PR string changed")
		}
		var stored string
		if err := database.Pool.QueryRow(context.Background(), `SELECT properties FROM tasks WHERE id=$1`, queryID(number)).Scan(&stored); err != nil || !strings.Contains(stored, `"title":"\ud800"`) {
			t.Fatalf("read changed unpaired Unicode bytes: %q %v", stored, err)
		}
		query.Page.After = &Position{CreatedAt: page.Items[0].CreatedAt, ID: page.Items[0].ID}
	}
}
