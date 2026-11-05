package project

import (
	"context"
	"errors"
	"math"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const transferTestUser = "00000000-0000-4000-8000-000000000001"
const transferTestProject = "00000000-0000-4000-8000-000000000002"
const transferTestSource = "00000000-0000-4000-8000-000000000003"
const transferTestTarget = "00000000-0000-4000-8000-000000000004"

func transferTestPrincipal() model.Principal {
	return model.Principal{UserID: transferTestUser, CredentialID: "00000000-0000-4000-8000-000000000005", Kind: model.SessionCredential}
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
func (d *transferTestDAO) ProjectAccess(context.Context, model.Principal) (model.ProjectAccess, error) {
	if err := d.call("access"); err != nil {
		return model.ProjectAccess{}, err
	}
	d.accessCount++
	if d.accessCount > 1 && d.afterAccess != nil {
		return model.ProjectAccess{}, d.afterAccess
	}
	return d.access, nil
}
func (d *transferTestDAO) Project(context.Context) (model.Project, error) {
	return d.project, d.call("project")
}
func (d *transferTestDAO) UpdateProjectSettings(_ context.Context, minutes int32) (model.Project, error) {
	if err := d.call("settings"); err != nil {
		return model.Project{}, err
	}
	d.project.Settings.ExecutionWarningMinutes = minutes
	d.project.Settings.Version++
	return d.project, nil
}
func (d *transferTestDAO) LockTransferOwnership(context.Context) (model.ProjectOwnership, error) {
	return d.ownership, d.call("ownership")
}
func (d *transferTestDAO) LockTransferTeams(_ context.Context, source, target string) (store.TransferTeam, store.TransferTeam, error) {
	if source != d.ownership.TeamID || target != d.target.Ref.ID && d.target.Ref.ID != "" {
		panic("unexpected Team locks")
	}
	return d.source, d.target, d.call("teams")
}
func (d *transferTestDAO) MoveOwnership(_ context.Context, target string) (model.ProjectOwnership, error) {
	if err := d.call("move"); err != nil {
		return model.ProjectOwnership{}, err
	}
	d.ownership.TeamID = target
	d.ownership.Version++
	return d.ownership, nil
}
func newTransferTestDAO() *transferTestDAO {
	role := model.ProjectAdmin
	return &transferTestDAO{ownership: model.ProjectOwnership{TeamID: transferTestSource, Version: 5}, source: store.TransferTeam{Ref: model.TeamRef{ID: transferTestSource}}, target: store.TransferTeam{Ref: model.TeamRef{ID: transferTestTarget}, Version: 7}, access: model.ProjectAccess{Role: model.ProjectAdmin, TeamRole: &role}, project: model.Project{Settings: model.ProjectSettings{Version: 3, ExecutionWarningMinutes: 60}}}
}
func transferTestInput() TransferInput {
	return TransferInput{Ownership: model.ProjectOwnership{TeamID: transferTestSource, Version: 5}, TargetTeam: TeamVersion{ID: transferTestTarget, Version: 7}, ExpectedUserID: transferTestUser}
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
	d := newTransferTestDAO()
	d.afterAccess = model.ErrNotFound
	receipt, err := Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestTarget, input)
	if err != nil || !receipt.Changed || receipt.ActorAccess != nil || receipt.Ownership.TeamID != transferTestTarget || receipt.Ownership.Version != 6 {
		t.Fatalf("receipt %#v, %v", receipt, err)
	}
	if want := []string{"ownership", "teams", "access", "move", "access"}; !reflect.DeepEqual(d.calls, want) {
		t.Fatalf("order %v, want %v", d.calls, want)
	}
	tests := []struct {
		name   string
		modify func(*transferTestDAO, *TransferInput)
		code   string
	}{
		{"not owner administrator", func(d *transferTestDAO, _ *TransferInput) { d.access.TeamRole = nil }, "forbidden"},
		{"stale ownership", func(_ *transferTestDAO, i *TransferInput) { i.Ownership.Version-- }, "version_conflict"},
		{"missing target", func(d *transferTestDAO, _ *TransferInput) { d.target.Ref.ID = "" }, "not_found"},
		{"stale team", func(_ *transferTestDAO, i *TransferInput) { i.TargetTeam.Version-- }, "version_conflict"},
		{"exhausted ownership", func(d *transferTestDAO, i *TransferInput) {
			d.ownership.Version = math.MaxInt64
			i.Ownership.Version = math.MaxInt64
		}, "version_exhausted"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := newTransferTestDAO()
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
	d = newTransferTestDAO()
	d.target = d.source
	d.target.Version = 7
	i := transferTestInput()
	i.TargetTeam.ID = transferTestSource
	receipt, err = Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestSource, i)
	if err != nil || receipt.Changed || receipt.ActorAccess == nil {
		t.Fatalf("no-op receipt %#v, %v", receipt, err)
	}
	if !reflect.DeepEqual(d.calls, []string{"ownership", "teams", "access", "access"}) {
		t.Fatal(d.calls)
	}
	cause := errors.New("store error")
	for _, stage := range []string{"ownership", "teams", "access", "move"} {
		t.Run(stage+" failure", func(t *testing.T) {
			d := newTransferTestDAO()
			d.fail = stage
			d.cause = cause
			_, err := Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestTarget, input)
			if !errors.Is(err, cause) {
				t.Fatalf("lost cause %v", err)
			}
		})
	}
	d = newTransferTestDAO()
	d.afterAccess = cause
	if _, err := Transfer(ctx, d, p, transferTestProject, transferTestSource, transferTestTarget, input); !errors.Is(err, cause) {
		t.Fatalf("lost post-transfer access failure %v", err)
	}
}

func TestSettingsChecksAccessBeforeVersionAndWrites(t *testing.T) {
	ctx := context.Background()
	p := transferTestPrincipal()
	input := UpdateProjectSettings{Version: 3, ExecutionWarningMinutes: 90}
	d := newTransferTestDAO()
	got, err := UpdateSettings(ctx, d, p, input)
	if err != nil || got.Settings.Version != 4 || got.Settings.ExecutionWarningMinutes != 90 || !reflect.DeepEqual(d.calls, []string{"access", "project", "settings"}) {
		t.Fatalf("result %#v calls %v err %v", got, d.calls, err)
	}
	d = newTransferTestDAO()
	d.access.Role = model.ProjectMemberRole
	_, err = UpdateSettings(ctx, d, p, input)
	transferTestFault(t, err, "forbidden")
	if !reflect.DeepEqual(d.calls, []string{"access"}) {
		t.Fatal(d.calls)
	}
	d = newTransferTestDAO()
	input.Version = 2
	_, err = UpdateSettings(ctx, d, p, input)
	transferTestFault(t, err, "version_conflict")
	if !reflect.DeepEqual(d.calls, []string{"access", "project"}) {
		t.Fatal(d.calls)
	}
	d = newTransferTestDAO()
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
			d := newTransferTestDAO()
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
	access model.ProjectAccess
	target store.TransferTeam
	role   *model.ProjectRole
	fail   string
	cause  error
}

func (d *transferPreviewTestDAO) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	if d.fail == "access" {
		return model.ProjectAccess{}, d.cause
	}
	return d.access, nil
}
func (d *transferPreviewTestDAO) TransferTeam(context.Context, string) (store.TransferTeam, error) {
	if d.fail == "team" {
		return store.TransferTeam{}, d.cause
	}
	return d.target, nil
}
func (d *transferPreviewTestDAO) TransferRole(context.Context, string, string, string) (*model.ProjectRole, error) {
	if d.fail == "role" {
		return nil, d.cause
	}
	return d.role, nil
}
func TestTransferPreviewAuthorizationAndErrors(t *testing.T) {
	ctx := context.Background()
	p := transferTestPrincipal()
	role := model.ProjectAdmin
	d := &transferPreviewTestDAO{access: model.ProjectAccess{TeamRole: &role, OwnerTeam: model.TeamRef{ID: transferTestSource}, Ownership: model.ProjectOwnership{TeamID: transferTestSource, Version: 5}}, target: store.TransferTeam{Ref: model.TeamRef{ID: transferTestTarget}, Version: 7}}
	got, err := TransferPreviewFor(ctx, d, p, transferTestProject, transferTestTarget)
	if err != nil || got.ActorRole != nil || got.TargetTeamVersion != 7 || got.Ownership.Version != 5 {
		t.Fatalf("preview %#v %v", got, err)
	}
	d.access.TeamRole = nil
	_, err = TransferPreviewFor(ctx, d, p, transferTestProject, transferTestTarget)
	transferTestFault(t, err, "forbidden")
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
