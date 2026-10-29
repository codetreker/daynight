package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestProjectSettingsSavedValueVersionAndMembership(t *testing.T) {
	f := newMembershipFixture(t)
	admin, member, outsider := f.user(t), f.user(t), f.user(t)
	project := f.project(t, admin, "Shared execution settings")
	other := f.project(t, admin, "Independent execution settings")
	f.join(t, admin, member, project.ID)
	ctx := context.Background()
	if project.Settings != (core.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}) {
		t.Fatalf("creation omitted explicit settings: %#v", project)
	}
	noop, err := f.projects.UpdateSettings(ctx, admin, strings.ToUpper(project.ID), UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 60})
	if err != nil || !reflect.DeepEqual(noop, project) {
		t.Fatalf("same-value save changed project metadata: %#v, %v", noop, err)
	}
	saved, err := f.projects.UpdateSettings(ctx, admin, project.ID, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90})
	if err != nil || saved.Settings != (core.ProjectSettings{Version: 2, ExecutionWarningMinutes: 90}) || !saved.UpdatedAt.After(project.UpdatedAt) || saved.CreatedAt != project.CreatedAt {
		t.Fatalf("real setting change did not update its own revision: %#v, %v", saved, err)
	}
	for _, principal := range []core.Principal{admin, member} {
		read, err := f.projects.Get(ctx, principal, project.ID)
		if err != nil || !reflect.DeepEqual(read, saved) {
			t.Fatalf("members disagree on saved settings: %#v, %v", read, err)
		}
	}
	_, err = f.projects.UpdateSettings(ctx, admin, project.ID, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90})
	requireFault(t, err, "version_conflict")
	_, err = f.projects.UpdateSettings(ctx, member, project.ID, UpdateProjectSettings{Version: 999, ExecutionWarningMinutes: 120})
	requireFault(t, err, "forbidden")
	_, err = f.projects.UpdateSettings(ctx, outsider, project.ID, UpdateProjectSettings{Version: 999, ExecutionWarningMinutes: 120})
	requireFault(t, err, "not_found")
	_, err = f.projects.UpdateSettings(ctx, admin, uuid.NewString(), UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90})
	requireFault(t, err, "not_found")
	read, err := f.projects.Get(ctx, admin, other.ID)
	if err != nil || !reflect.DeepEqual(read, other) {
		t.Fatalf("settings leaked to a second project: %#v, %v", read, err)
	}
	read, err = f.projects.Get(ctx, admin, project.ID)
	if err != nil || !reflect.DeepEqual(read, saved) {
		t.Fatalf("refused writes changed saved settings: %#v, %v", read, err)
	}
	listed, err := f.projects.List(ctx, member, PageRequest{Limit: 10})
	if err != nil || len(listed.Items) != 1 || !reflect.DeepEqual(listed.Items[0], saved) {
		t.Fatalf("accessible project projection lost settings: %#v, %v", listed, err)
	}
	task := createTask(t, NewTasks(f.database), member, project.ID, "Settings context")
	graph, err := NewTasks(f.database).Graph(ctx, member, project.ID, task.ID)
	if err != nil || !reflect.DeepEqual(graph.Project, saved) {
		t.Fatalf("graph project projection lost settings: %#v, %v", graph, err)
	}
}

func TestProjectSettingsValidationBeforeStorage(t *testing.T) {
	_, _, _, principal := projectService(t)
	projects := NewProjects(nil)
	ctx := context.Background()
	for _, absent := range []core.Principal{{}, {UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: "unknown"}} {
		_, err := projects.UpdateSettings(ctx, absent, uuid.NewString(), UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 60})
		requireFault(t, err, "unauthenticated")
	}
	_, err := projects.UpdateSettings(ctx, principal, "invalid", UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 60})
	requireFault(t, err, "invalid_input")
	for _, input := range []UpdateProjectSettings{{}, {Version: -1, ExecutionWarningMinutes: 60}, {Version: 1}, {Version: 1, ExecutionWarningMinutes: -1}} {
		_, err := projects.UpdateSettings(ctx, principal, uuid.NewString(), input)
		requireFault(t, err, "invalid_input")
	}
}

func TestProjectSettingsSameVersionWritersHaveOneWinner(t *testing.T) {
	f := newMembershipFixture(t)
	admin := f.user(t)
	project := f.project(t, admin, "Settings race")
	results := competeTaskWrites(t, f.database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			_, err := f.projects.UpdateSettings(ctx, admin, project.ID, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90})
			return core.Task{}, err
		},
		func(ctx context.Context) (core.Task, error) {
			_, err := f.projects.UpdateSettings(ctx, admin, project.ID, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 120})
			return core.Task{}, err
		})
	assertOneTaskWinner(t, results, "version_conflict")
	read, err := f.projects.Get(context.Background(), admin, project.ID)
	if err != nil || read.Settings.Version != 2 || read.Settings.ExecutionWarningMinutes != 90 && read.Settings.ExecutionWarningMinutes != 120 {
		t.Fatalf("concurrent saves produced an invalid setting: %#v, %v", read, err)
	}
}

func TestProjectSettingsChecksCurrentAdministratorAfterProjectLock(t *testing.T) {
	for _, remove := range []bool{false, true} {
		t.Run(fmt.Sprintf("remove=%v", remove), func(t *testing.T) {
			f := newMembershipFixture(t)
			owner, target := f.user(t), f.user(t)
			project := f.project(t, owner, "Queued administrator")
			other := f.project(t, owner, "Other project remains available")
			membership := f.join(t, owner, target, project.ID)
			if _, err := f.memberships.SetRole(context.Background(), owner, project.ID, target.UserID, membership.Version, core.ProjectAdmin); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			result := make(chan taskResult, 1)
			var releasedAt time.Time
			if err := f.database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error {
				if remove {
					if err := tx.RemoveMember(ctx, target.UserID); err != nil {
						return err
					}
				} else if _, err := tx.SetMemberRole(ctx, target.UserID, core.ProjectMemberRole); err != nil {
					return err
				}
				go func() {
					_, err := f.projects.UpdateSettings(ctx, target, project.ID, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90})
					result <- taskResult{err: err}
				}()
				waitForTaskWriters(t, ctx, f.database, 1)
				independent, stop := context.WithTimeout(ctx, 2*time.Second)
				defer stop()
				updated, err := f.projects.UpdateSettings(independent, owner, other.ID, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 120})
				if err != nil || updated.Settings.Version != 2 {
					t.Fatalf("unrelated project was blocked by settings lock: %#v, %v", updated, err)
				}
				return f.database.Pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&releasedAt)
			}); err != nil {
				t.Fatal(err)
			}
			code := "forbidden"
			if remove {
				code = "not_found"
			}
			requireFault(t, receiveTaskResult(t, ctx, result).err, code)
			read, err := f.projects.Get(ctx, owner, project.ID)
			if err != nil || !reflect.DeepEqual(read, project) {
				t.Fatalf("queued former administrator changed settings: %#v, %v", read, err)
			}
			updated, err := f.projects.UpdateSettings(ctx, owner, project.ID, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90})
			if err != nil || updated.UpdatedAt.Before(releasedAt) {
				t.Fatalf("settings update used time before the lock release: %#v, %v", updated, err)
			}
		})
	}
}

func TestProjectSettingsCancellationAndDatabaseFailuresPreserveTheSavedProject(t *testing.T) {
	for _, test := range []struct {
		name, match string
		cancelAfter bool
		minutes     int32
	}{
		{"member refusal completion", "FROM project_members m", true, 90},
		{"project query", "SELECT id::text, name, repo_url", false, 90},
		{"noop completion", "SELECT id::text, name, repo_url", true, 60},
		{"update query", "UPDATE projects SET execution_warning_minutes", false, 90},
		{"update completion", "UPDATE projects SET execution_warning_minutes", true, 90},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newMembershipFixture(t)
			admin, member := f.user(t), f.user(t)
			project := f.project(t, admin, "Canceled settings")
			f.join(t, admin, member, project.ID)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			action := taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, test.match) }}
			if test.cancelAfter {
				action.end = cancel
			} else {
				action.start = cancel
			}
			traced := NewProjects(tracedTasks(t, f.database.Pool.Config().ConnConfig.ConnString(), action).store)
			principal := admin
			if test.name == "member refusal completion" {
				principal = member
			}
			updated, err := traced.UpdateSettings(ctx, principal, project.ID, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: test.minutes})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(updated, core.Project{}) {
				t.Fatalf("canceled operation returned saved state or lost cause: %#v, %v", updated, err)
			}
			read, err := f.projects.Get(context.Background(), admin, project.ID)
			if err != nil || !reflect.DeepEqual(read, project) {
				t.Fatalf("canceled settings write committed data: %#v, %v", read, err)
			}
		})
	}
	f := newMembershipFixture(t)
	admin := f.user(t)
	project := f.project(t, admin, "Version overflow must roll back")
	if _, err := f.database.Pool.Exec(context.Background(), "UPDATE projects SET settings_version=9223372036854775807 WHERE id=$1", project.ID); err != nil {
		t.Fatal(err)
	}
	before, err := f.projects.Get(context.Background(), admin, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.projects.UpdateSettings(context.Background(), admin, project.ID, UpdateProjectSettings{Version: before.Settings.Version, ExecutionWarningMinutes: 90})
	assertOperational(t, err)
	var postgres *pgconn.PgError
	if !errors.As(err, &postgres) || postgres.Code != "22003" {
		t.Fatalf("failed settings write lost its database cause: %v", err)
	}
	after, err := f.projects.Get(context.Background(), admin, project.ID)
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("overflow partly updated project settings: %#v, %v", after, err)
	}
	f.database.Close()
	_, err = f.projects.UpdateSettings(context.Background(), admin, project.ID, UpdateProjectSettings{Version: before.Settings.Version, ExecutionWarningMinutes: 90})
	assertOperational(t, err)
}
