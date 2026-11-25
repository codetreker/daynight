package team

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type settingsHTTPWriter struct {
	store.TeamWriteDAO
	team   model.Team
	writes int
}

func (d *settingsHTTPWriter) Team(_ context.Context, user string) (model.Team, error) {
	if user != d.team.Membership.UserID {
		return model.Team{}, model.ErrNotFound
	}
	return d.team, nil
}
func (d *settingsHTTPWriter) SetNestedSubtask(_ context.Context, user string, value bool) (model.Team, error) {
	if user != d.team.Membership.UserID {
		panic("wrong actor")
	}
	d.writes++
	d.team.Version++
	d.team.AllowNestedSubtask = value
	return d.team, nil
}

func TestSettingsHTTPRouteInputAndTransactions(t *testing.T) {
	db := newHTTPTestStore(t)
	h := teamComponentHost(t, db, io.Discard)
	id := "22222222-2222-4222-8222-222222222222"
	team := model.Team{TeamRef: model.TeamRef{ID: id, Kind: "personal"}, Version: 9007199254740993, Membership: model.TeamMember{UserID: h.principal.UserID, Role: model.ProjectAdmin}}
	w := &settingsHTTPWriter{team: team}
	db.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		return op(teamHTTPSnapshot{reader: teamHTTPReader{Read: func(_ context.Context, user, actualID string) (model.Team, error) {
			if user != h.principal.UserID || actualID != id {
				t.Fatal("incorrect read identity")
			}
			return w.team, nil
		}}})
	}
	var writeCalls int
	var finishErr error
	db.WriteTeamCall = func(ctx context.Context, actualID string, op func(store.TeamWriteScope) error) (store.Completion, error) {
		writeCalls++
		if actualID != id {
			t.Fatal("incorrect write identity")
		}
		if err := op(teamHTTPWriteScope{dao: w}); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		if finishErr != nil {
			return store.Completion{Outcome: store.TransactionUnknown}, finishErr
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	path := "/api/v1/teams/" + id + "/settings"
	read := teamComponentRequest(h, http.MethodGet, path, "")
	if got := decodeResponse[api.TeamSettings](t, read, 200); got.Version != team.Version || got.AllowNestedSubtask {
		t.Fatalf("settings=%+v", got)
	}
	if read.Header().Get("Daynight-User-ID") != h.principal.UserID || read.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("headers=%v", read.Header())
	}
	for _, value := range []string{"", `,"allowNestedSubtask":null`, `,"allowNestedSubtask":"true"`, `,"allowNestedSubtask":1`, `,"allowNestedSubtask":true,"unknown":0`} {
		body := fmt.Sprintf(`{"version":%d,"expectedUserId":%q%s}`, team.Version, h.principal.UserID, value)
		assertProjectError(t, teamComponentRequest(h, http.MethodPatch, path, body), 400, "invalid_input")
	}
	for _, body := range []string{
		`{"expectedUserId":"` + h.principal.UserID + `","allowNestedSubtask":true}`,
		`{"version":null,"expectedUserId":"` + h.principal.UserID + `","allowNestedSubtask":true}`,
		`{"version":0,"expectedUserId":"` + h.principal.UserID + `","allowNestedSubtask":true}`,
		`{"version":1,"allowNestedSubtask":false}`,
		`{"version":1,"expectedUserId":null,"allowNestedSubtask":false}`,
	} {
		assertProjectError(t, teamComponentRequest(h, http.MethodPatch, path, body), 400, "invalid_input")
	}
	assertProjectError(t, teamComponentRequest(h, http.MethodGet, path+"?unexpected=1", ""), 400, "invalid_input")
	if writeCalls != 0 {
		t.Fatal("invalid input reached transaction")
	}
	body := fmt.Sprintf(`{"version":%d,"expectedUserId":%q,"allowNestedSubtask":true}`, team.Version, h.principal.UserID)
	result := teamComponentRequest(h, http.MethodPatch, path, body)
	if got := decodeResponse[api.TeamSettings](t, result, 200); got.Version != team.Version+1 || !got.AllowNestedSubtask || w.writes != 1 {
		t.Fatalf("update=%+v writes=%d", got, w.writes)
	}
	assertProjectError(t, teamComponentRequest(h, http.MethodPatch, path, body), 409, "version_conflict")
	if w.writes != 1 {
		t.Fatal("stale version changed setting")
	}
	finishErr = &store.TransactionError{Phase: "commit", Cause: errors.New("private detail"), Outcome: store.TransactionUnknown, CommitAttempted: true}
	body = fmt.Sprintf(`{"version":%d,"expectedUserId":%q,"allowNestedSubtask":false}`, w.team.Version, h.principal.UserID)
	unknown := teamComponentRequest(h, http.MethodPatch, path, body)
	assertProjectError(t, unknown, 503, "write_outcome_unknown")
	if strings.Contains(unknown.Body.String(), "private") || w.writes != 2 || writeCalls != 3 {
		t.Fatalf("unknown=%s writes=%d calls=%d", unknown.Body.String(), w.writes, writeCalls)
	}
}
