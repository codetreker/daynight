package project

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const transferTestUser = contractActor
const transferTestProject = "f0000000-0000-4000-8000-000000000000"
const transferTestSource = "e5555555-5555-4555-8555-555555555555"
const transferTestTarget = "a7777777-7777-4777-8777-777777777777"

func transferTestPrincipal() model.Principal {
	return contractPrincipal()
}

func transferTestFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}

type transferTestDAO struct {
	store.ProjectWriteDAO
	t              *testing.T
	ctx            context.Context
	expectedTarget string
	calls          []string
	ownership      model.ProjectOwnership
	source, target store.TransferTeam
	access         model.ProjectAccess
	project        model.Project
	fail           string
	cause          error
	accessCount    int
	afterAccess    error
}

func (d *transferTestDAO) call(name string) error {
	d.calls = append(d.calls, name)
	if d.fail == name {
		return d.cause
	}
	return nil
}
func (d *transferTestDAO) ProjectAccess(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
	if ctx != d.ctx {
		d.t.Fatal("DAO changed context")
	}
	contractEqual(d.t, p, transferTestPrincipal())
	if err := d.call("access"); err != nil {
		return model.ProjectAccess{}, err
	}
	d.accessCount++
	if d.accessCount > 1 && d.afterAccess != nil {
		return model.ProjectAccess{}, d.afterAccess
	}
	return contractCloneAccess(d.access), nil
}
func (d *transferTestDAO) Project(ctx context.Context) (model.Project, error) {
	if ctx != d.ctx {
		d.t.Fatal("DAO changed context")
	}
	return d.project, d.call("project")
}
func (d *transferTestDAO) UpdateProjectSettings(ctx context.Context, minutes int32) (model.Project, error) {
	if ctx != d.ctx {
		d.t.Fatal("DAO changed context")
	}
	if err := d.call("settings"); err != nil {
		return model.Project{}, err
	}
	d.project.Settings.ExecutionWarningMinutes = minutes
	d.project.Settings.Version++
	return d.project, nil
}
func (d *transferTestDAO) LockTransferOwnership(ctx context.Context) (model.ProjectOwnership, error) {
	if ctx != d.ctx {
		d.t.Fatal("DAO changed context")
	}
	return d.ownership, d.call("ownership")
}
func (d *transferTestDAO) LockTransferTeams(ctx context.Context, source, target string) (store.TransferTeam, store.TransferTeam, error) {
	if ctx != d.ctx {
		d.t.Fatal("DAO changed context")
	}
	contractEqual(d.t, []string{source, target}, []string{d.ownership.TeamID, d.expectedTarget})
	return d.source, d.target, d.call("teams")
}
func (d *transferTestDAO) MoveOwnership(ctx context.Context, target string) (model.ProjectOwnership, error) {
	if ctx != d.ctx {
		d.t.Fatal("DAO changed context")
	}
	contractEqual(d.t, target, d.expectedTarget)
	if err := d.call("move"); err != nil {
		return model.ProjectOwnership{}, err
	}
	d.ownership.TeamID = target
	d.ownership.Version++
	d.ownership.UpdatedAt = d.ownership.UpdatedAt.Add(time.Second)
	return d.ownership, nil
}
func newTransferTestDAO(t *testing.T, ctx context.Context) *transferTestDAO {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	value := contractProject(transferTestProject, "Project", "https://github.com/acme/test.git", transferTestSource)
	access := contractAccess(transferTestPrincipal(), value)
	name := "Destination"
	return &transferTestDAO{t: t, ctx: ctx, expectedTarget: transferTestTarget,
		ownership: value.Ownership,
		source:    store.TransferTeam{Ref: model.TeamRef{ID: transferTestSource, Kind: "personal"}, Version: 1},
		target:    store.TransferTeam{Ref: model.TeamRef{ID: transferTestTarget, Kind: "ordinary", Name: &name}, Version: 1},
		access:    access, project: model.Project{ID: value.ID, Name: value.Name, RepoURL: value.RepoURL, CreatedAt: at, UpdatedAt: at, Ownership: value.Ownership, Settings: model.ProjectSettings{Version: 3, ExecutionWarningMinutes: 60}}}
}
func transferTestInput() TransferInput {
	return TransferInput{Ownership: model.ProjectOwnership{TeamID: transferTestSource, Version: 1}, TargetTeam: TeamVersion{ID: transferTestTarget, Version: 1}, ExpectedUserID: transferTestUser}
}

func TestTransferSettingsValidation(t *testing.T) {
	p := transferTestPrincipal()
	input := transferTestInput()
	if id, source, target, err := ValidateTransfer(p, transferTestProject, input); err != nil || id != transferTestProject || source != transferTestSource || target != transferTestTarget {
		t.Fatalf("valid transfer: %s %s %s %v", id, source, target, err)
	}
	for _, tc := range []struct {
		name  string
		p     model.Principal
		id    string
		input TransferInput
	}{
		{"actor", model.Principal{}, transferTestProject, input},
		{"project", p, "invalid", input},
		{"source", p, transferTestProject, TransferInput{Ownership: model.ProjectOwnership{TeamID: "invalid", Version: 5}, TargetTeam: input.TargetTeam, ExpectedUserID: transferTestUser}},
		{"target", p, transferTestProject, TransferInput{Ownership: input.Ownership, TargetTeam: TeamVersion{ID: "invalid", Version: 7}, ExpectedUserID: transferTestUser}},
		{"version", p, transferTestProject, TransferInput{Ownership: input.Ownership, TargetTeam: TeamVersion{ID: transferTestTarget}, ExpectedUserID: transferTestUser}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, _, err := ValidateTransfer(tc.p, tc.id, tc.input); err == nil {
				t.Fatal("accepted invalid transfer")
			}
		})
	}
	if _, _, err := ValidateTransferPreview(p, transferTestProject, transferTestTarget); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ValidateTransferPreview(model.Principal{}, transferTestProject, transferTestTarget); err == nil {
		t.Fatal("accepted invalid preview actor")
	}
	if _, _, err := ValidateTransferPreview(p, transferTestProject, "invalid"); err == nil {
		t.Fatal("accepted invalid target")
	}
	if _, err := ValidateSettings(p, transferTestProject, UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateSettings(p, transferTestProject, UpdateProjectSettings{}); err == nil {
		t.Fatal("accepted invalid settings")
	}
	if _, err := ValidateSettings(model.Principal{}, transferTestProject, UpdateProjectSettings{}); err == nil {
		t.Fatal("accepted invalid actor")
	}
}

func TestTransferLockOrderVersionsAndLostAccess(t *testing.T) {
	ctx := context.Background()
	p := transferTestPrincipal()
	input := transferTestInput()
	d := newTransferTestDAO(t, ctx)
	d.afterAccess = model.ErrNotFound
	receipt, err := Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestTarget, input)
	if err != nil {
		t.Fatal(err)
	}
	targetName := "Destination"
	wantReceipt := TransferReceipt{ProjectID: transferTestProject, Changed: true,
		SourceTeam: model.TeamRef{ID: transferTestSource, Kind: "personal"},
		OwnerTeam:  model.TeamRef{ID: transferTestTarget, Kind: "ordinary", Name: &targetName},
		Ownership:  model.ProjectOwnership{TeamID: transferTestTarget, Version: 2, UpdatedAt: time.Date(2026, 1, 1, 0, 0, 1, 0, time.UTC)}, ActorAccess: nil}
	contractEqual(t, receipt, wantReceipt)
	if want := []string{"ownership", "teams", "access", "move", "access"}; !reflect.DeepEqual(d.calls, want) {
		t.Fatalf("order %v, want %v", d.calls, want)
	}
	tests := []struct {
		name   string
		modify func(*transferTestDAO, *TransferInput)
		code   string
	}{
		{"not owner administrator", func(d *transferTestDAO, _ *TransferInput) { d.access.TeamRole = nil }, "forbidden"},
		{"stale ownership", func(_ *transferTestDAO, i *TransferInput) { i.Ownership.Version = 999 }, "version_conflict"},
		{"missing target", func(d *transferTestDAO, _ *TransferInput) { d.target.Ref.ID = "" }, "not_found"},
		{"stale team", func(_ *transferTestDAO, i *TransferInput) { i.TargetTeam.Version-- }, "version_conflict"},
		{"exhausted ownership", func(d *transferTestDAO, i *TransferInput) {
			d.ownership.Version = math.MaxInt64
			i.Ownership.Version = math.MaxInt64
		}, "version_exhausted"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := newTransferTestDAO(t, ctx)
			i := transferTestInput()
			tc.modify(d, &i)
			_, err := Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestTarget, i)
			transferTestFault(t, err, tc.code)
			for _, call := range d.calls {
				if call == "move" {
					t.Fatal("refused transfer moved ownership")
				}
			}
		})
	}
	d = newTransferTestDAO(t, ctx)
	d.target = d.source
	d.target.Version = 1
	d.expectedTarget = transferTestSource
	i := transferTestInput()
	i.TargetTeam.ID = transferTestSource
	receipt, err = Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestSource, i)
	if err != nil {
		t.Fatal(err)
	}
	original := contractProject(transferTestProject, "Project", "https://github.com/acme/test.git", transferTestSource)
	expectedAccess := contractAccess(p, original)
	contractEqual(t, receipt, TransferReceipt{ProjectID: transferTestProject, Changed: false, SourceTeam: model.TeamRef{ID: transferTestSource, Kind: "personal"}, OwnerTeam: model.TeamRef{ID: transferTestSource, Kind: "personal"}, Ownership: original.Ownership, ActorAccess: &expectedAccess})
	if !reflect.DeepEqual(d.calls, []string{"ownership", "teams", "access", "access"}) {
		t.Fatal(d.calls)
	}
	cause := errors.New("store error")
	for _, stage := range []string{"ownership", "teams", "access", "move"} {
		t.Run(stage+" failure", func(t *testing.T) {
			d := newTransferTestDAO(t, ctx)
			d.fail = stage
			d.cause = cause
			_, err := Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestTarget, input)
			if !errors.Is(err, cause) {
				t.Fatalf("lost cause %v", err)
			}
		})
	}
	d = newTransferTestDAO(t, ctx)
	d.afterAccess = cause
	if _, err := Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestTarget, input); !errors.Is(err, cause) {
		t.Fatalf("lost post-transfer access failure %v", err)
	}
}

func TestSettingsChecksAccessBeforeVersionAndWrites(t *testing.T) {
	ctx := context.Background()
	p := transferTestPrincipal()
	input := UpdateProjectSettings{Version: 3, ExecutionWarningMinutes: 90}
	d := newTransferTestDAO(t, ctx)
	got, err := UpdateSettings(ctx, d, p, input)
	if err != nil || got.Settings.Version != 4 || got.Settings.ExecutionWarningMinutes != 90 || !reflect.DeepEqual(d.calls, []string{"access", "project", "settings"}) {
		t.Fatalf("result %#v calls %v err %v", got, d.calls, err)
	}
	d = newTransferTestDAO(t, ctx)
	d.access.Role = model.ProjectMemberRole
	_, err = UpdateSettings(ctx, d, p, input)
	transferTestFault(t, err, "forbidden")
	if !reflect.DeepEqual(d.calls, []string{"access"}) {
		t.Fatal(d.calls)
	}
	d = newTransferTestDAO(t, ctx)
	input.Version = 2
	_, err = UpdateSettings(ctx, d, p, input)
	transferTestFault(t, err, "version_conflict")
	if !reflect.DeepEqual(d.calls, []string{"access", "project"}) {
		t.Fatal(d.calls)
	}
	d = newTransferTestDAO(t, ctx)
	input.Version = 3
	input.ExecutionWarningMinutes = 60
	got, err = UpdateSettings(ctx, d, p, input)
	if err != nil || got.Settings.Version != 3 || !reflect.DeepEqual(d.calls, []string{"access", "project"}) {
		t.Fatalf("no-op %#v %v %v", got, d.calls, err)
	}
	cause := errors.New("store error")
	input.ExecutionWarningMinutes = 90
	for _, stage := range []string{"access", "project", "settings"} {
		t.Run(stage+" failure", func(t *testing.T) {
			d := newTransferTestDAO(t, ctx)
			d.fail = stage
			d.cause = cause
			_, err := UpdateSettings(ctx, d, p, input)
			if !errors.Is(err, cause) {
				t.Fatalf("lost cause %v", err)
			}
		})
	}
}

type transferPreviewTestDAO struct {
	store.ProjectReader
	t      *testing.T
	ctx    context.Context
	calls  []string
	access model.ProjectAccess
	target store.TransferTeam
	role   *model.ProjectRole
	fail   string
	cause  error
}

func (d *transferPreviewTestDAO) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	if ctx != d.ctx {
		d.t.Fatal("DAO changed context")
	}
	contractEqual(d.t, p, transferTestPrincipal())
	contractEqual(d.t, id, transferTestProject)
	d.calls = append(d.calls, "access")
	if d.fail == "access" {
		return model.ProjectAccess{}, d.cause
	}
	return contractCloneAccess(d.access), nil
}
func (d *transferPreviewTestDAO) TransferTeam(ctx context.Context, id string) (store.TransferTeam, error) {
	if ctx != d.ctx {
		d.t.Fatal("DAO changed context")
	}
	contractEqual(d.t, id, transferTestTarget)
	d.calls = append(d.calls, "team")
	if d.fail == "team" {
		return store.TransferTeam{}, d.cause
	}
	return d.target, nil
}
func (d *transferPreviewTestDAO) TransferRole(ctx context.Context, user, project, team string) (*model.ProjectRole, error) {
	contractEqual(d.t, ctx, d.ctx)
	contractEqual(d.t, []string{user, project, team}, []string{transferTestUser, transferTestProject, transferTestTarget})
	d.calls = append(d.calls, "role")
	if d.fail == "role" {
		return nil, d.cause
	}
	return d.role, nil
}
func TestTransferPreviewAuthorizationAndErrors(t *testing.T) {
	ctx := context.Background()
	p := transferTestPrincipal()
	role := model.ProjectAdmin
	value := contractProject(transferTestProject, "Project", "https://github.com/acme/test.git", transferTestSource)
	targetName := "Destination"
	d := &transferPreviewTestDAO{t: t, ctx: ctx, access: contractAccess(p, value), target: store.TransferTeam{Ref: model.TeamRef{ID: transferTestTarget, Kind: "ordinary", Name: &targetName}, Version: 1}}
	got, err := TransferPreviewFor(ctx, d, p, transferTestProject, transferTestTarget)
	wantName := "Destination"
	want := TransferPreview{SourceTeam: model.TeamRef{ID: transferTestSource, Kind: "personal"}, TargetTeam: model.TeamRef{ID: transferTestTarget, Kind: "ordinary", Name: &wantName}, Ownership: value.Ownership, TargetTeamVersion: 1, ActorRole: nil}
	if err != nil {
		t.Fatal(err)
	}
	contractEqual(t, got, want)
	contractEqual(t, d.calls, []string{"access", "team", "role"})
	d.calls = nil
	d.fail, d.cause = "access", model.ErrNotFound
	_, err = TransferPreviewFor(ctx, d, p, transferTestProject, transferTestTarget)
	transferTestFault(t, err, "not_found")
	contractEqual(t, d.calls, []string{"access"})
	d.fail = ""
	d.calls = nil
	d.access.TeamRole = nil
	_, err = TransferPreviewFor(ctx, d, p, transferTestProject, transferTestTarget)
	transferTestFault(t, err, "forbidden")
	contractEqual(t, d.calls, []string{"access"})
	d.access.TeamRole = &role
	d.fail = "team"
	d.cause = model.ErrNotFound
	_, err = TransferPreviewFor(ctx, d, p, transferTestProject, transferTestTarget)
	transferTestFault(t, err, "not_found")
	cause := errors.New("database failure")
	d.cause = cause
	for _, stage := range []string{"access", "team", "role"} {
		d.fail = stage
		_, err = TransferPreviewFor(ctx, d, p, transferTestProject, transferTestTarget)
		if !errors.Is(err, cause) {
			t.Fatalf("%s lost cause %v", stage, err)
		}
	}
}
