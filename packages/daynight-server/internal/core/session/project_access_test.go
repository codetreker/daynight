package session

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
)

type projectAdmissionDAO struct {
	store.SessionDAO
	access func(context.Context, string, string) (model.ProjectAccess, error)
}

func (dao projectAdmissionDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	if dao.access == nil {
		panic("unexpected ProjectAccess")
	}
	return dao.access(ctx, user, project)
}
func TestProjectAdmissionRequiresCanonicalProjectAndUser(t *testing.T) {
	profileFailure := errors.New("canonical user profile missing")
	for _, test := range []struct {
		name   string
		result error
		code   string
	}{
		{name: "projects", result: store.ErrSessionProjectNotFound, code: "not_found"},
		{name: "users", result: &store.Error{Phase: "query", Cause: profileFailure}},
		{name: "access removed", result: model.ErrNotFound, code: "forbidden"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			calls := 0
			dao := projectAdmissionDAO{access: func(actual context.Context, user, project string) (model.ProjectAccess, error) {
				calls++
				if actual != ctx || user != "user" || project != "project" || calls != 1 {
					t.Fatal("canonical access lookup changed its context, identity or count")
				}
				return model.ProjectAccess{}, test.result
			}}
			op := &Operation{engine: NewEngine(nil)}
			err := op.CheckProjectAccess(ctx, operationLoadScope{dao: dao}, model.Principal{UserID: "user"}, "project")
			if calls != 1 {
				t.Fatal("canonical access lookup was skipped")
			}
			var refusal *model.Fault
			if test.code != "" {
				if !errors.As(err, &refusal) || refusal.Code != test.code {
					t.Fatal("canonical access result had the wrong refusal", err)
				}
			} else {
				var query *store.Error
				if !errors.As(err, &query) || !errors.Is(err, test.result) || !errors.Is(err, profileFailure) || errors.As(err, &refusal) {
					t.Fatal("missing canonical profile was hidden as a refusal", err)
				}
			}
		})
	}
}
func TestProjectAdmissionPreservesQueryFailure(t *testing.T) {
	ctx := t.Context()
	cause := errors.New("project access query unavailable")
	query := &store.Error{Phase: "query", Cause: cause}
	calls := 0
	dao := projectAdmissionDAO{access: func(actual context.Context, user, project string) (model.ProjectAccess, error) {
		calls++
		if actual != ctx || user != "user" || project != "project" || calls != 1 {
			t.Fatal("query changed its context, identity or count")
		}
		return model.ProjectAccess{}, query
	}}
	op := &Operation{engine: NewEngine(nil)}
	err := op.CheckProjectAccess(ctx, operationLoadScope{dao: dao}, model.Principal{UserID: "user"}, "project")
	var refusal *model.Fault
	if calls != 1 || !errors.Is(err, query) || !errors.Is(err, cause) || errors.As(err, &refusal) {
		t.Fatal("admission query failure lost its cause or became a refusal", err)
	}
}
func assertAdmissionDenied(t *testing.T, err error) {
	t.Helper()
	var refusal *model.Fault
	if !errors.As(err, &refusal) || refusal.Code != "forbidden" {
		t.Fatal("expected forbidden admission", err)
	}
}
