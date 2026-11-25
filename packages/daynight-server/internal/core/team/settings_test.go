package team

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type settingsWriter struct {
	store.TeamWriteDAO
	team     model.Team
	err      error
	writeErr error
	writes   int
}

func (w *settingsWriter) Team(context.Context, string) (model.Team, error) { return w.team, w.err }
func (w *settingsWriter) SetNestedSubtask(_ context.Context, user string, value bool) (model.Team, error) {
	w.writes++
	if user != w.team.Membership.UserID {
		panic("wrong actor")
	}
	if w.writeErr != nil {
		return model.Team{}, w.writeErr
	}
	w.team.AllowNestedSubtask = value
	w.team.Version++
	return w.team, w.err
}

func TestSettingsAuthorizationVersionAndChange(t *testing.T) {
	auth := scopeAuth(t, "team:read", "team:write")
	p := auth.Principal
	base := namedTeam(p)
	input := ChangeSettings{Version: base.Version, ExpectedUserID: p.UserID, AllowNestedSubtask: true}
	if id, err := ValidateSettingsChange(p, base.ID, input); err != nil || id != base.ID {
		t.Fatalf("validation: %s %v", id, err)
	}
	wrong := input
	wrong.ExpectedUserID = principal().UserID
	_, err := ValidateSettingsChange(p, base.ID, wrong)
	faultCode(t, err, "identity_mismatch")
	wrong = input
	wrong.Version = 0
	_, err = ValidateSettingsChange(p, base.ID, wrong)
	faultCode(t, err, "invalid_input")
	_, err = ValidateSettingsChange(p, "invalid", input)
	faultCode(t, err, "invalid_input")

	for _, kind := range []string{"ordinary", "personal"} {
		t.Run(kind, func(t *testing.T) {
			team := base
			team.Kind = kind
			w := &settingsWriter{team: team}
			got, err := UpdateSettings(scopeContext(auth), w, p, input)
			if err != nil || got != (Settings{Version: 2, AllowNestedSubtask: true}) || w.writes != 1 {
				t.Fatalf("update=%+v %v writes=%d", got, err, w.writes)
			}
			input2 := input
			input2.Version = 2
			got, err = UpdateSettings(scopeContext(auth), w, p, input2)
			if err != nil || got.Version != 2 || w.writes != 1 {
				t.Fatalf("same value=%+v %v writes=%d", got, err, w.writes)
			}
			_, err = UpdateSettings(scopeContext(auth), w, p, input)
			faultCode(t, err, "version_conflict")
			if w.writes != 1 {
				t.Fatal("stale version wrote")
			}
		})
	}
	w := &settingsWriter{team: base}
	w.team.Membership.Role = model.ProjectMemberRole
	_, err = UpdateSettings(scopeContext(auth), w, p, input)
	faultCode(t, err, "forbidden")
	w.team.Membership.Role = model.ProjectAdmin
	readOnly := scopeAuth(t, "team:read")
	readOnly.Principal = p
	_, err = UpdateSettings(scopeContext(readOnly), w, p, input)
	faultCode(t, err, "insufficient_scope")
	if w.writes != 0 {
		t.Fatal("refusal wrote")
	}
	w.team.Version = math.MaxInt64
	input.Version = math.MaxInt64
	_, err = UpdateSettings(scopeContext(auth), w, p, input)
	faultCode(t, err, "version_exhausted")
	input.AllowNestedSubtask = false
	got, err := UpdateSettings(scopeContext(auth), w, p, input)
	if err != nil || got.Version != math.MaxInt64 || w.writes != 0 {
		t.Fatalf("same value at limit=%+v %v", got, err)
	}
	w.err = errors.New("storage failed")
	_, err = UpdateSettings(scopeContext(auth), w, p, input)
	if !errors.Is(err, w.err) {
		t.Fatalf("lost storage error %v", err)
	}
	w.err = nil
	w.writeErr = errors.New("write failed")
	w.team.Version = 1
	input.Version = 1
	input.AllowNestedSubtask = true
	_, err = UpdateSettings(scopeContext(auth), w, p, input)
	if !errors.Is(err, w.writeErr) {
		t.Fatalf("lost write error %v", err)
	}
}

func TestSettingsReadUsesMembershipAndScope(t *testing.T) {
	auth := scopeAuth(t, "team:read")
	p := auth.Principal
	team := namedTeam(p)
	team.Membership.Role = model.ProjectMemberRole
	team.AllowNestedSubtask = true
	reader := &readerFake{team: team}
	got, err := GetSettings(scopeContext(auth), reader, p, team.ID)
	if err != nil || got != (Settings{Version: team.Version, AllowNestedSubtask: true}) {
		t.Fatalf("read=%+v %v", got, err)
	}
	reader.teamErr = model.ErrNotFound
	_, err = GetSettings(scopeContext(auth), reader, p, team.ID)
	faultCode(t, err, "not_found")
	reader.teamErr = nil
	denied := scopeAuth(t, "task:read")
	denied.Principal = p
	_, err = GetSettings(scopeContext(denied), reader, p, team.ID)
	faultCode(t, err, "insufficient_scope")
}
