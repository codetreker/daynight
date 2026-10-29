package main

import (
	"context"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestInstalledCLIExternalDependencyWriteAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_external_dependency_writes_restart", []string{"ED-R2", "ED-R3", "ED-R7"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		cli := newAcceptanceCLI(t, receipt, scenario)
		process := fixture.launch(t, nil).started(t)
		cli.configure(t, process)
		projectID := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "project", "create", "External dependency write contract"))
		create := func(title string, dependencyOptions ...string) api.Task {
			id := acceptanceCLIResourceID(t, cli.run(t, cli.repo, append([]string{"task", "create", "--title", title}, dependencyOptions...)...))
			return cli.task(t, id)
		}
		a, b, c := create("A"), create("B"), create("C")
		target := create("Mixed target", "--depends-on", a.ID, "--external-depends-on", b.ID)
		both := []string{a.ID, b.ID}
		slices.Sort(both)
		if !slices.Equal(target.DependsOn, both) || !slices.Equal(target.ExternalDependsOn, []string{b.ID}) || !slices.Equal(target.BlockedBy, both) {
			t.Fatal("installed creation did not compile the dependency union and exact external subset")
		}
		onlyExternal := create("Only external", "--external-depends-on", c.ID)
		if !slices.Equal(onlyExternal.DependsOn, []string{c.ID}) || !slices.Equal(onlyExternal.ExternalDependsOn, []string{c.ID}) {
			t.Fatal("installed external-only creation did not create its real prerequisite")
		}
		update := func(options ...string) {
			before := target
			cli.run(t, cli.repo, append([]string{"task", "update", target.ID, "--if-version", strconv.FormatInt(target.Version, 10)}, options...)...)
			target = cli.task(t, target.ID)
			if target.Version != before.Version+1 || !target.UpdatedAt.After(before.UpdatedAt) || target.Status != before.Status || !reflect.DeepEqual(target.StartedAt, before.StartedAt) || !reflect.DeepEqual(target.CompletedAt, before.CompletedAt) {
				t.Fatal("installed classification replacement changed lifecycle or lost its exact version")
			}
		}
		update("--external-depends-on", c.ID)
		if !slices.Equal(target.DependsOn, []string{c.ID}) || !slices.Equal(target.ExternalDependsOn, []string{c.ID}) {
			t.Fatal("installed external-only update appended instead of replacing dependencies")
		}
		update("--depends-on", a.ID)
		if !slices.Equal(target.DependsOn, []string{a.ID}) || len(target.ExternalDependsOn) != 0 {
			t.Fatal("installed normal-only update retained an external marker")
		}
		update("--depends-on", a.ID, "--external-depends-on", b.ID)
		before := target
		update("--description", "Dependency options omitted")
		if !slices.Equal(target.DependsOn, before.DependsOn) || !slices.Equal(target.ExternalDependsOn, before.ExternalDependsOn) {
			t.Fatal("installed metadata update changed omitted relationships")
		}
		count := len(acceptanceCLIMutations(process))
		for _, options := range [][]string{{"--depends-on", a.ID, "--external-depends-on", a.ID}, {"--clear-dependencies", "--external-depends-on", b.ID}} {
			result := acceptanceCLIReceive(t, cli.start(t, cli.repo, append([]string{"task", "update", target.ID}, options...)...))
			if result.status != 2 || result.stdout != "" || result.stderr == "" || len(acceptanceCLIMutations(process)) != count {
				t.Fatal("installed duplicate or clear conflict reached a mutation or lost its usage failure")
			}
		}
		before = target
		target = acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(target), map[string]any{"version": target.Version, "externalDependsOn": []string{a.ID}}, "external-flags-only"), http.StatusOK)
		preserved := target
		preserved.ExternalDependsOn, preserved.Version, preserved.UpdatedAt = before.ExternalDependsOn, before.Version, before.UpdatedAt
		if target.Version != before.Version+1 || !target.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) || !slices.Equal(target.ExternalDependsOn, []string{a.ID}) {
			t.Fatal("public flags-only patch changed fields other than classification and version metadata")
		}
		noop := acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(target), map[string]any{"version": target.Version, "externalDependsOn": target.ExternalDependsOn}, "external-flags-noop"), http.StatusOK)
		if !reflect.DeepEqual(noop, target) {
			t.Fatal("public flags-only no-op changed metadata")
		}
		cli.refuse(t, process, "version_conflict", target.ID, "task", "update", target.ID, "--project", projectID, "--external-depends-on", a.ID, "--if-version", strconv.FormatInt(before.Version, 10))
		if after := cli.task(t, target.ID); !reflect.DeepEqual(after, target) {
			t.Fatal("installed stale classification replaced the winning state")
		}
		update("--clear-dependencies")
		if len(target.DependsOn) != 0 || len(target.ExternalDependsOn) != 0 {
			t.Fatal("installed clear did not remove both dependency sets")
		}
		update("--external-depends-on", c.ID)
		cli.refuse(t, process, "dependency_unsatisfied", c.ID, "task", "set-status", target.ID, "in_progress", "--project", projectID, "--if-version", strconv.FormatInt(target.Version, 10))
		graph := acceptanceCLIGraphResource(t, cli.run(t, cli.repo, "task", "graph", target.ID, "--json"))
		if len(graph.Tasks) != 2 || graph.Tasks[0].ID != c.ID || graph.Tasks[1].ID != target.ID || !slices.Equal(graph.Tasks[1].ExternalDependsOn, target.ExternalDependsOn) {
			t.Fatal("installed graph did not expose newly written classification")
		}
		process.signal(t)
		process.stopped(t, 0)
		restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
		if after := cli.task(t, target.ID); !reflect.DeepEqual(after, target) {
			t.Fatal("installed classified write did not survive service restart")
		}
		if after := cli.task(t, onlyExternal.ID); !reflect.DeepEqual(after, onlyExternal) {
			t.Fatal("installed external-only creation changed across restart")
		}
		restarted.signal(t)
		restarted.stopped(t, 0)
	})
}
