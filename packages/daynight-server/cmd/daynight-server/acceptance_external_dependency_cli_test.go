package main

import (
	"context"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestInstalledCLIExternalDependencyReadAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_external_dependency_reads_restart", []string{"ED-R1", "ED-R3", "ED-R8"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		cli := newAcceptanceCLI(t, receipt, scenario)
		evidence := newLifecycleEvidence(t, scenario)
		process := fixture.launch(t, nil).started(t)
		cli.configure(t, process)
		projectID := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "project", "create", "External dependency read contract"))
		prerequisiteID := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "task", "create", "--title", "External prerequisite"))
		targetID := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "task", "create", "--title", "Classified dependent", "--description", "Preserve stored edge metadata.", "--depends-on", prerequisiteID))
		prerequisite, target := cli.task(t, prerequisiteID), cli.task(t, targetID)
		if target.ExternalDependsOn == nil || len(target.ExternalDependsOn) != 0 {
			t.Fatal("installed CLI did not read normal edge default")
		}
		fixture.exec(t, `UPDATE task_dependencies SET external=true WHERE project_id=$1 AND task_id=$2 AND depends_on_task_id=$3`, projectID, targetID, prerequisiteID)
		target = cli.task(t, target.ID)
		if !slices.Equal(target.ExternalDependsOn, []string{prerequisiteID}) || !slices.Equal(target.BlockedBy, []string{prerequisiteID}) {
			t.Fatal("installed CLI full task read lost seeded classification or blocking")
		}
		cli.run(t, cli.repo, "task", "update", target.ID, "--allow-agents", "true", "--if-version", strconv.FormatInt(target.Version, 10))
		target = cli.task(t, target.ID)
		if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, []string{prerequisiteID}) {
			t.Fatal("installed permission update lost stored edge classification")
		}
		for _, output := range []string{cli.run(t, cli.repo, "task", "show", target.ID), cli.run(t, cli.repo, "task", "list"), cli.run(t, cli.repo, "task", "graph", target.ID)} {
			if !strings.Contains(output, "External dependencies (1): "+prerequisiteID+"\n") {
				t.Fatal("installed CLI text output lost external classification")
			}
		}
		acceptanceCLITaskListJSON(t, cli.run(t, cli.repo, "task", "list", "--json"), []api.Task{prerequisite, target})
		graph := acceptanceCLIGraphResource(t, cli.run(t, cli.repo, "task", "graph", target.ID, "--json"))
		if len(graph.Tasks) != 2 || !slices.Equal(graph.Tasks[1].ExternalDependsOn, target.ExternalDependsOn) {
			t.Fatal("installed CLI graph omitted seeded classification")
		}
		acceptanceError(t, process.request(context.Background(), http.MethodPatch, "/api/v1/projects/"+projectID+"/tasks/"+target.ID, map[string]any{"version": target.Version, "externalDependsOn": []string{target.ID}}, "invalid-external-subset"), http.StatusBadRequest, "invalid_input")
		if after := cli.task(t, target.ID); !reflect.DeepEqual(after, target) {
			t.Fatal("invalid external subset changed the classified task")
		}
		for _, arguments := range [][]string{{"--title", "Renamed classified dependent"}, {"--description", "Metadata retains edge classification."}, {"--pull-request-url", "https://example.com/pr/1", "--pull-request-title", "Preserved reference"}} {
			cli.run(t, cli.repo, append([]string{"task", "update", target.ID, "--if-version", strconv.FormatInt(target.Version, 10)}, arguments...)...)
			target = cli.task(t, target.ID)
			if !slices.Equal(target.ExternalDependsOn, []string{prerequisiteID}) {
				t.Fatal("installed ordinary update lost external classification")
			}
		}
		target = acceptanceCLISetStatus(t, cli, process, evidence, target, "todo")
		acceptanceCLIRefusal(t, cli, process, evidence, target, "dependency_unsatisfied", "task", "set-status", target.ID, "in_progress", "--project", projectID, "--if-version", strconv.FormatInt(target.Version, 10))
		for _, status := range []string{"in_progress", "done"} {
			prerequisite = acceptanceCLISetStatus(t, cli, process, evidence, prerequisite, status)
		}
		target = cli.task(t, target.ID)
		ready := acceptanceCLIJSON[[]api.Task](t, cli.run(t, cli.repo, "task", "ready", "--json"))
		if len(ready) != 1 || !reflect.DeepEqual(ready[0], target) || !target.Ready || !slices.Equal(target.ExternalDependsOn, []string{prerequisiteID}) {
			t.Fatal("installed ready read lost classification after prerequisite completion")
		}
		if output := cli.run(t, cli.repo, "task", "ready"); !strings.Contains(output, "External dependencies (1): "+prerequisiteID+"\n") {
			t.Fatal("installed ready text omitted classification")
		}
		target = acceptanceCLISetStatus(t, cli, process, evidence, target, "in_progress")
		target = acceptanceCLISetStatus(t, cli, process, evidence, target, "done")
		if !target.AllowAgents || !slices.Equal(target.ExternalDependsOn, []string{prerequisiteID}) {
			t.Fatal("installed execution actions lost classification")
		}
		acceptanceCLITaskListJSON(t, cli.run(t, cli.repo, "task", "list", "--all", "--json"), []api.Task{prerequisite, target})
		graph = acceptanceCLIGraphResource(t, cli.run(t, cli.repo, "task", "graph", target.ID, "--json"))
		process.signal(t)
		process.stopped(t, 0)
		restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
		if after := cli.task(t, target.ID); !reflect.DeepEqual(after, target) {
			t.Fatal("classified task changed across service restart")
		}
		if after := cli.task(t, prerequisite.ID); !reflect.DeepEqual(after, prerequisite) {
			t.Fatal("prerequisite changed across service restart")
		}
		afterGraph := acceptanceCLIGraphResource(t, cli.run(t, cli.repo, "task", "graph", target.ID, "--json"))
		afterGraph.ObservedAt = graph.ObservedAt
		if !reflect.DeepEqual(afterGraph, graph) {
			t.Fatal("classified graph changed across service restart")
		}
		restarted.signal(t)
		restarted.stopped(t, 0)
	})
}
