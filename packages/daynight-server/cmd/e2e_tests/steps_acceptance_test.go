package e2e_tests

import (
	"context"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestBuiltBinaryStepsReadPersistence(t *testing.T) {
	acceptanceCase(t, "steps_seeded_restart_reads", []string{"ST-R1", "ST-R2", "ST-R3", "ST-R4"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		process := fixture.launch(t, nil).started(t)
		project := process.project(t, "Steps persistence")
		task := process.task(t, project, "Steps parent")
		path := acceptanceTaskPath(task) + "/steps"
		empty := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, "steps-empty"), 200)
		if empty.Steps == nil || len(empty.Steps) != 0 || empty.Version != task.Version {
			t.Fatal("new Task does not expose a real empty Steps collection")
		}
		fixture.exec(t, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 VALUES($1,'00000000',0,'Coding 第 1 轮','# 结果\n跨进程保留','done','2026-11-03T10:11:12.123456Z','2026-11-03T11:12:13.654321Z'),
 ($1,'abcdef01',1,'Review 第 1 轮','需修改','skipped','2026-11-03T11:12:13Z','2026-11-03T11:12:13Z')`, task.ID)
		fixture.exec(t, `UPDATE tasks SET version=9007199254740993 WHERE id=$1`, task.ID)
		before := process.readTask(t, task)
		first := acceptanceDecode[api.StepsResource](t, process.request(context.Background(), http.MethodGet, path, nil, "steps-first"), 200)
		if len(first.Steps) != 2 || first.Version != 9007199254740993 || first.Steps[0].ID != "00000000" || first.Steps[1].Status != "skipped" {
			t.Fatal("seeded collection identity, precision or order changed")
		}
		process.signal(t)
		process.stopped(t, 0)
		restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
		second := acceptanceDecode[api.StepsResource](t, restarted.request(context.Background(), http.MethodGet, path, nil, "steps-restart"), 200)
		if !reflect.DeepEqual(first, second) || !reflect.DeepEqual(before, restarted.readTask(t, task)) {
			t.Fatal("Steps read or restart changed persisted facts")
		}
		item := acceptanceDecode[api.StepResource](t, restarted.request(context.Background(), http.MethodGet, path+"/ABCDEF01", nil, "steps-item"), 200)
		if item.Step != second.Steps[1] || item.Version != second.Version {
			t.Fatal("single Step lookup lost Task scope or uppercase input normalization")
		}
	})
}
