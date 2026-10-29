package main

import (
	"context"
	"net/http"
	"reflect"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func acceptanceCLIAllowAgents(t *testing.T, cli *acceptanceCLI, process *acceptanceProcess) {
	t.Helper()
	project := acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Installed automatic permission", RepoURL: "https://github.com/example/allow-agents"}, "permission-installed-project"), http.StatusCreated)
	create := func(title string) api.Task {
		id := acceptanceCLIResourceID(t, cli.run(t, cli.caller, "task", "create", "--project", project.ID, "--title", title))
		task := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", id, "--project", project.ID, "--json"))
		if task.AllowAgents || task.Status != "todo" || !task.Ready {
			t.Fatal("installed creation enabled automation or was not ready todo")
		}
		return task
	}
	update := func(before api.Task, allowed bool) api.Task {
		cli.run(t, cli.caller, "task", "update", before.ID, "--project", project.ID, "--if-version", strconv.FormatInt(before.Version, 10), "--allow-agents", strconv.FormatBool(allowed))
		after := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", before.ID, "--project", project.ID, "--json"))
		if after.AllowAgents != allowed || after.Status != before.Status || after.Ready != before.Ready || !reflect.DeepEqual(after.StartedAt, before.StartedAt) || !reflect.DeepEqual(after.CompletedAt, before.CompletedAt) {
			t.Fatal("installed permission-only update changed lifecycle or execution timing")
		}
		return after
	}
	manual := create("Earlier manual task")
	allowed := create("Automatic candidate")
	allowed = update(allowed, true)
	noOp := update(allowed, true)
	if !reflect.DeepEqual(noOp, allowed) {
		t.Fatal("installed same-value permission update changed version/time")
	}
	cli.refuse(t, process, "version_conflict", allowed.ID, "task", "update", allowed.ID, "--project", project.ID, "--if-version", strconv.FormatInt(allowed.Version-1, 10), "--allow-agents", "true")

	ready := acceptanceCLIJSON[[]api.Task](t, cli.run(t, cli.caller, "task", "ready", "--project", project.ID, "--allow-agents", "true", "--limit", "1", "--json"))
	if !reflect.DeepEqual(ready, []api.Task{allowed}) {
		t.Fatal("installed ready filtering applied after bounded page or changed automation state")
	}
	acceptanceCLITaskListJSON(t, cli.run(t, cli.caller, "task", "list", "--project", project.ID, "--allow-agents", "false", "--ready", "--json"), []api.Task{manual})
	allowed = update(allowed, false)
	empty := acceptanceCLIJSON[[]api.Task](t, cli.run(t, cli.caller, "task", "ready", "--project", project.ID, "--allow-agents", "true", "--json"))
	if len(empty) != 0 {
		t.Fatal("installed false update left automatic candidate")
	}
	cli.run(t, cli.caller, "task", "set-status", allowed.ID, "in_progress", "--project", project.ID, "--if-version", strconv.FormatInt(allowed.Version, 10))
	active := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", allowed.ID, "--project", project.ID, "--json"))
	if active.AllowAgents || active.Status != "in_progress" || active.StartedAt == nil {
		t.Fatal("explicit installed status assignment did not preserve false permission")
	}
	sameActive := update(active, false)
	if !reflect.DeepEqual(sameActive, active) {
		t.Fatal("installed active same-value request changed resource")
	}
	cli.refuse(t, process, "invalid_transition", "", "task", "update", active.ID, "--project", project.ID, "--if-version", strconv.FormatInt(active.Version, 10), "--allow-agents", "true")
	graph := acceptanceCLIGraphResource(t, cli.run(t, cli.caller, "task", "graph", active.ID, "--project", project.ID, "--json"))
	for _, task := range graph.Tasks {
		if task.AllowAgents {
			t.Fatal("installed graph changed saved false permission")
		}
	}
	persisted := acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodGet, acceptanceTaskPath(active), nil, "permission-installed-readback"), http.StatusOK)
	if !reflect.DeepEqual(persisted, active) {
		t.Fatal("installed refusal changed actual service resource")
	}
}
