package project

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type settingsContractDAO struct {
	store.ProjectWriteDAO
	access  func(context.Context, model.Principal) (model.ProjectAccess, error)
	project func(context.Context) (model.Project, error)
	update  func(context.Context, int32) (model.Project, error)
}

func (d settingsContractDAO) ProjectAccess(c context.Context, p model.Principal) (model.ProjectAccess, error) {
	return d.access(c, p)
}
func (d settingsContractDAO) Project(c context.Context) (model.Project, error) { return d.project(c) }
func (d settingsContractDAO) UpdateProjectSettings(c context.Context, n int32) (model.Project, error) {
	return d.update(c, n)
}

func TestProjectSettingsExactRevisionsAndWholeNoop(t *testing.T) {
	p := contractPrincipal()
	initial := contractProject("a0000000-0000-4000-8000-000000000001", "Settings", "https://example.com/settings.git", "00000000-0000-4000-8000-000000000101")
	first := initial
	first.Settings = model.ProjectSettings{Version: 2, ExecutionWarningMinutes: 90}
	first.UpdatedAt = initial.UpdatedAt.Add(time.Second)
	const exact int64 = 9007199254740993
	precise := first
	precise.Settings.Version = exact
	maximum := precise
	maximum.Settings = model.ProjectSettings{Version: exact + 1, ExecutionWarningMinutes: 2147483647}
	maximum.UpdatedAt = initial.UpdatedAt.Add(2 * time.Second)
	minimum := maximum
	minimum.Settings = model.ProjectSettings{Version: exact + 2, ExecutionWarningMinutes: 1}
	minimum.UpdatedAt = initial.UpdatedAt.Add(3 * time.Second)
	for _, tc := range []struct {
		name   string
		before model.Project
		input  UpdateProjectSettings
		result model.Project
		write  bool
		code   string
	}{
		{"initial no-op", initial, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 60}, initial, false, ""},
		{"ordinary update", initial, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90}, first, true, ""},
		{"updated no-op", first, UpdateProjectSettings{Version: 2, ExecutionWarningMinutes: 90}, first, false, ""},
		{"ordinary stale", first, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90}, model.Project{}, false, "version_conflict"},
		{"large revision maximum minutes", precise, UpdateProjectSettings{Version: exact, ExecutionWarningMinutes: 2147483647}, maximum, true, ""},
		{"large revision no-op", maximum, UpdateProjectSettings{Version: exact + 1, ExecutionWarningMinutes: 2147483647}, maximum, false, ""},
		{"large revision stale", maximum, UpdateProjectSettings{Version: exact, ExecutionWarningMinutes: 2147483647}, model.Project{}, false, "version_conflict"},
		{"minimum minutes", maximum, UpdateProjectSettings{Version: exact + 1, ExecutionWarningMinutes: 1}, minimum, true, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			names := []string{"access", "project"}
			if tc.write {
				names = append(names, "update")
			}
			take := contractPlan(t, ctx, names...)
			dao := settingsContractDAO{
				access: func(c context.Context, actor model.Principal) (model.ProjectAccess, error) {
					take(c, "access")
					contractEqual(t, actor, p)
					return contractAccess(p, tc.before), nil
				},
				project: func(c context.Context) (model.Project, error) { take(c, "project"); return tc.before, nil },
				update: func(c context.Context, n int32) (model.Project, error) {
					take(c, "update")
					contractEqual(t, n, tc.input.ExecutionWarningMinutes)
					return tc.result, nil
				},
			}
			id, err := ValidateSettings(p, initial.ID, tc.input)
			if err != nil || id != initial.ID {
				t.Fatalf("validation=%q %v", id, err)
			}
			got, err := UpdateSettings(ctx, dao, p, tc.input)
			if tc.code != "" {
				faultCode(t, err, tc.code)
			} else if err != nil {
				t.Fatal(err)
			}
			contractEqual(t, got, tc.result)
		})
	}
	authProject := contractProject("00000000-0000-4000-8000-000000000001", "Project settings authorization", "https://example.com/settings", "00000000-0000-4000-8000-000000000101")
	for _, tc := range []struct {
		name      string
		p         model.Principal
		accessErr error
		code      string
	}{
		{"member", model.Principal{UserID: "a2222222-2222-4222-8222-222222222222", CredentialID: "b3333333-3333-4333-8333-333333333333", Kind: model.SessionCredential}, nil, "forbidden"},
		{"outsider", model.Principal{UserID: "a3333333-3333-4333-8333-333333333333", CredentialID: "b4444444-4444-4444-8444-444444444444", Kind: model.SessionCredential}, model.ErrNotFound, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			take := contractPlan(t, ctx, "access")
			dao := settingsContractDAO{access: func(c context.Context, actor model.Principal) (model.ProjectAccess, error) {
				take(c, "access")
				contractEqual(t, actor, tc.p)
				access := contractAccess(tc.p, authProject)
				access.Role = model.ProjectMemberRole
				return access, tc.accessErr
			}}
			got, err := UpdateSettings(ctx, dao, tc.p, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90})
			faultCode(t, err, tc.code)
			if tc.accessErr != nil && !errors.Is(err, tc.accessErr) {
				t.Fatalf("lost cause: %v", err)
			}
			contractEqual(t, got, model.Project{})
		})
	}
}
