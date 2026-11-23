package oauth

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type descriptionWriter struct {
	store.GrantLifecycleDAO
	principal       model.Principal
	grantID         string
	changed, exists bool
	steps           []string
	expected, value *string
	sessionErr      error
	unknown         bool
}

func (d *descriptionWriter) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	err := fn(d)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	if d.unknown {
		return store.Completion{Outcome: store.TransactionUnknown}, nil
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (d *descriptionWriter) UpdateOwnerGrantDescription(_ context.Context, user, id string, expected, value *string) (bool, error) {
	if user != d.principal.UserID || id != d.grantID {
		panic("wrong owner or grant")
	}
	d.steps = append(d.steps, "update")
	d.expected, d.value = expected, value
	return d.changed, nil
}
func (d *descriptionWriter) OwnerGrantExists(_ context.Context, user, id string) (bool, error) {
	if user != d.principal.UserID || id != d.grantID {
		panic("wrong existence scope")
	}
	d.steps = append(d.steps, "exists")
	return d.exists, nil
}
func (d *descriptionWriter) FreshTime(context.Context, time.Time) (time.Time, error) {
	d.steps = append(d.steps, "time")
	return time.Now(), nil
}
func (d *descriptionWriter) LockOwnerSession(_ context.Context, principal model.Principal, _ time.Time) error {
	if principal != d.principal {
		panic("wrong session")
	}
	d.steps = append(d.steps, "session")
	return d.sessionErr
}

func TestUpdateSessionGrantDescription(t *testing.T) {
	value, old := "  hello  ", "old"
	for _, tc := range []struct {
		name                     string
		changed, exists, unknown bool
		sessionErr               error
		code                     string
		steps                    []string
	}{
		{"saved", true, true, false, nil, "", []string{"update", "time", "session", "time", "session"}},
		{"conflict", false, true, false, nil, "version_conflict", []string{"update", "exists", "time", "session", "time", "session"}},
		{"missing", false, false, false, nil, "not_found", []string{"update", "exists", "time", "session", "time", "session"}},
		{"expired", true, true, false, model.ErrNotFound, "unauthenticated", []string{"update", "time", "session"}},
		{"unknown", true, true, true, nil, "unknown", []string{"update", "time", "session", "time", "session"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			d := &descriptionWriter{principal: p, grantID: uuid.NewString(), changed: tc.changed, exists: tc.exists, sessionErr: tc.sessionErr, unknown: tc.unknown}
			got, err := NewGrantLifecycle(d).UpdateSessionGrantDescription(t.Context(), p, p.UserID, d.grantID, &old, &value)
			if !reflect.DeepEqual(d.steps, tc.steps) || d.expected != &old || d.value == nil || *d.value != "hello" {
				t.Fatalf("calls %v", d.steps)
			}
			switch tc.code {
			case "":
				if err != nil || got == nil || *got != "hello" {
					t.Fatalf("result %v %v", got, err)
				}
			case "not_found":
				if !errors.Is(err, model.ErrNotFound) || got != nil {
					t.Fatalf("result %v %v", got, err)
				}
			case "unknown":
				if !errors.Is(err, ErrAuthorizationUnknown) || got != nil {
					t.Fatalf("result %v %v", got, err)
				}
			default:
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != tc.code || got != nil {
					t.Fatalf("result %v %v", got, err)
				}
			}
		})
	}
}

func TestUpdateSessionGrantDescriptionRejectsBeforeTransaction(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	d := &descriptionWriter{principal: p, grantID: uuid.NewString()}
	bad, noncanonical := "bad\n", " old "
	for _, input := range []struct {
		user, id        string
		expected, value *string
		code            string
	}{
		{uuid.NewString(), d.grantID, nil, nil, "identity_mismatch"},
		{p.UserID, "bad", nil, nil, "invalid_input"},
		{p.UserID, d.grantID, &noncanonical, nil, "invalid_input"},
		{p.UserID, d.grantID, nil, &bad, "invalid_input"},
	} {
		_, err := NewGrantLifecycle(d).UpdateSessionGrantDescription(t.Context(), p, input.user, input.id, input.expected, input.value)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != input.code || len(d.steps) != 0 {
			t.Fatalf("input %+v: %v", input, err)
		}
	}
}
