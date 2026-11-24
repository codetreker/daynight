package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

type expiryClockDAO struct {
	*identityDAO
	fresh      time.Time
	sessionErr error
}

func (d *expiryClockDAO) FreshPATTime(_ context.Context, _ time.Time) (time.Time, error) {
	d.calls = append(d.calls, "fresh-pat-time")
	return d.fresh, d.failures["fresh-pat-time"]
}

func (d *expiryClockDAO) LockSession(_ context.Context, _ model.Principal, now time.Time) error {
	d.calls = append(d.calls, "lock-session")
	if now.Equal(d.fresh) {
		return d.sessionErr
	}
	return nil
}

func TestPATExpiryRechecksAfterTargetLock(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fresh := now.Add(2 * time.Minute)
	beforeFresh := now.Add(time.Minute)
	afterFresh := now.Add(3 * time.Minute)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id := uuid.NewString()
	failure := errors.New("clock failure")
	for _, tc := range []struct {
		name                 string
		current, desired     *time.Time
		sessionErr, clockErr error
		code                 string
		cause                error
		wantWrite            bool
	}{
		{name: "target expired waiting", current: &beforeFresh, desired: &afterFresh, code: "not_found"},
		{name: "new expiry elapsed waiting", desired: &beforeFresh, code: "invalid_input"},
		{name: "session expired waiting", desired: &afterFresh, sessionErr: model.ErrNotFound, code: "not_found"},
		{name: "clock failed", desired: &afterFresh, clockErr: failure, cause: failure},
		{name: "still valid", desired: &afterFresh, wantWrite: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := &identityDAO{pat: model.PersonalAccessToken{ID: id, UserID: p.UserID, ExpiresAt: tc.current}, failures: map[string]error{"fresh-pat-time": tc.clockErr}}
			dao := &expiryClockDAO{identityDAO: base, fresh: fresh, sessionErr: tc.sessionErr}
			_, err := NewIdentity("").UpdatePATExpiry(t.Context(), dao, p, id, UpdatePATExpiry{ExpiresAt: tc.desired, ExpectedExpiresAt: tc.current, ExpectedUserID: p.UserID}, now)
			if tc.code != "" {
				checkFault(t, err, tc.code)
			} else if tc.cause != nil {
				if !errors.Is(err, tc.cause) {
					t.Fatalf("cause lost: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			want := []string{"lock-session", "lock-pat", "fresh-pat-time"}
			if tc.clockErr == nil {
				want = append(want, "lock-session")
			}
			if tc.wantWrite {
				want = append(want, "set-expiry")
			}
			if !reflect.DeepEqual(dao.calls, want) {
				t.Fatalf("calls %v, want %v", dao.calls, want)
			}
		})
	}
}
