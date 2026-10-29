package main

import (
	"context"
	"net/http"
	"reflect"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestInstalledCLIPlatformAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_platform_status_workflow", []string{"PT.V1", "PT.V3", "PT.V7", "TS1", "TS3", "TS5"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		cli := newAcceptanceCLI(t, receipt, scenario)
		process := fixture.launch(t, nil).started(t)
		cli.configure(t, process)
		acceptanceCLIPlatforms(t, cli, process)
		process.signal(t)
		process.stopped(t, 0)
	})
}

func acceptanceCLIPlatforms(t *testing.T, cli *acceptanceCLI, process *acceptanceProcess) {
	t.Helper()
	project := acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Installed task platforms", RepoURL: "https://github.com/example/platforms"}, "platform-installed-project"), http.StatusCreated)
	read := func(id string) api.Task {
		return acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", id, "--project", project.ID, "--json"))
	}
	create := func(platform string) api.Task {
		arguments := []string{"task", "create", "--project", project.ID, "--title", "Platform candidate"}
		if platform != "" {
			arguments = append(arguments, "--required-platform", platform)
		}
		task := read(acceptanceCLIResourceID(t, cli.run(t, cli.caller, arguments...)))
		if platform == "" && task.RequiredPlatform != nil || platform != "" && (task.RequiredPlatform == nil || *task.RequiredPlatform != platform) {
			t.Fatal("installed creation lost required platform")
		}
		cli.run(t, cli.caller, "task", "update", task.ID, "--project", project.ID, "--if-version", strconv.FormatInt(task.Version, 10), "--allow-agents", "true")
		task = read(task.ID)
		return task
	}
	windows := create("windows")
	linux := create("linux")
	unrestricted := create("")
	macos := create("macos")
	ready := acceptanceCLIJSON[[]api.Task](t, cli.run(t, cli.caller, "task", "ready", "--project", project.ID, "--allow-agents", "true", "--compatible-platform", "linux", "--limit", "1", "--json"))
	if !reflect.DeepEqual(ready, []api.Task{linux}) {
		t.Fatal("installed bounded query hid later compatible task")
	}
	acceptanceCLITaskListJSON(t, cli.run(t, cli.caller, "task", "list", "--project", project.ID, "--ready", "--allow-agents", "true", "--compatible-platform", "linux", "--json"), []api.Task{linux, unrestricted})
	setStatus := func(before api.Task, status string) api.Task {
		cli.run(t, cli.caller, "task", "set-status", before.ID, status, "--project", project.ID, "--if-version", strconv.FormatInt(before.Version, 10))
		after := read(before.ID)
		acceptanceTaskTimingTransition(t, before, after, status)
		preserved := after
		preserved.StartedAt, preserved.CompletedAt = before.StartedAt, before.CompletedAt
		preserved.Status, preserved.Ready, preserved.Version, preserved.UpdatedAt = before.Status, before.Ready, before.Version, before.UpdatedAt
		expectedVersion := before.Version
		if before.Status != status {
			expectedVersion++
		}
		if after.Status != status || after.Version != expectedVersion || before.Status == status && !after.UpdatedAt.Equal(before.UpdatedAt) || before.Status != status && !after.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) {
			t.Fatal("installed status assignment changed platform or other materials, or returned the wrong version branch")
		}
		return after
	}
	for _, task := range []*api.Task{&windows, &linux, &unrestricted, &macos} {
		for _, status := range []string{"todo", "in_progress", "in_progress", "done", "done", "todo", "done", "in_progress", "todo"} {
			*task = setStatus(*task, status)
			if status != "in_progress" {
				continue
			}
			different := "linux"
			if task.RequiredPlatform != nil && *task.RequiredPlatform == different {
				different = "windows"
			}
			cli.refuse(t, process, "invalid_transition", "", "task", "update", task.ID, "--project", project.ID, "--if-version", strconv.FormatInt(task.Version, 10), "--required-platform", different, "--title", "Must not save")
			if got := read(task.ID); !reflect.DeepEqual(got, *task) {
				t.Fatal("installed in-progress platform refusal partially saved task materials")
			}
		}
	}
	cli.run(t, cli.caller, "task", "update", windows.ID, "--project", project.ID, "--if-version", strconv.FormatInt(windows.Version, 10), "--required-platform", "windows")
	if got := read(windows.ID); !reflect.DeepEqual(got, windows) {
		t.Fatal("installed same platform update changed resource")
	}
	cli.refuse(t, process, "version_conflict", windows.ID, "task", "update", windows.ID, "--project", project.ID, "--if-version", strconv.FormatInt(windows.Version-1, 10), "--required-platform", "windows")
	cli.run(t, cli.caller, "task", "update", windows.ID, "--project", project.ID, "--if-version", strconv.FormatInt(windows.Version, 10), "--clear-required-platform")
	cleared := read(windows.ID)
	if cleared.RequiredPlatform != nil || !cleared.AllowAgents || cleared.Status != windows.Status || cleared.Version != windows.Version+1 {
		t.Fatal("installed clear changed unrelated state")
	}
	cli.run(t, cli.caller, "task", "set-status", linux.ID, "in_progress", "--project", project.ID, "--if-version", strconv.FormatInt(linux.Version, 10))
	active := read(linux.ID)
	if active.RequiredPlatform == nil || *active.RequiredPlatform != "linux" || active.StartedAt == nil {
		t.Fatal("installed manual status assignment lost platform or timing")
	}
	cli.refuse(t, process, "invalid_transition", "", "task", "update", active.ID, "--project", project.ID, "--if-version", strconv.FormatInt(active.Version, 10), "--clear-required-platform")
	if got := read(active.ID); !reflect.DeepEqual(got, active) {
		t.Fatal("installed locked platform changed actual task")
	}
	graph := acceptanceCLIGraphResource(t, cli.run(t, cli.caller, "task", "graph", active.ID, "--project", project.ID, "--json"))
	for _, task := range graph.Tasks {
		if task.ID == active.ID && (task.RequiredPlatform == nil || *task.RequiredPlatform != "linux") {
			t.Fatal("installed graph lost platform")
		}
	}
}
