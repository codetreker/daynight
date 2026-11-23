package identity

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type browserDAO struct {
	store.IdentityDAO
	store.PreviewSSODAO
	ctx               context.Context
	hash              []byte
	preview           bool
	session           model.Session
	now               time.Time
	lockErr, touchErr error
	touched           int
	used, expires     time.Time
}

func (d *browserDAO) SessionTime(context.Context) (time.Time, error) { return d.now, nil }
func (d *browserDAO) LockBrowserSession(ctx context.Context, hash []byte, preview bool) (model.Session, time.Time, error) {
	if ctx != d.ctx || !bytes.Equal(hash, d.hash) || preview != d.preview {
		panic("unexpected credential binding")
	}
	return d.session, d.now, d.lockErr
}
func (d *browserDAO) TouchBrowserSession(ctx context.Context, id string, used, expires time.Time) error {
	if ctx != d.ctx || id != d.session.ID {
		panic("unexpected session touch")
	}
	d.touched++
	d.used, d.expires = used, expires
	return d.touchErr
}

func TestBrowserActivityPreservesCredentialAndMonotonicTimes(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, preview := range []bool{false, true} {
		for _, future := range []bool{false, true} {
			prefix := "dnst_"
			if preview {
				prefix = previewSecretPrefix
			}
			value := secret.Random(prefix)
			used := now.Add(-time.Hour)
			expiry := now.Add(time.Hour)
			if future {
				used = now.Add(time.Minute)
				expiry = used.Add(SessionLifetime + time.Hour)
			}
			d := &browserDAO{ctx: t.Context(), hash: secret.Hash(value), preview: preview, now: now, session: model.Session{ID: uuid.NewString(), UserID: uuid.NewString(), LastUsedAt: &used, ExpiresAt: expiry}}
			p := model.Principal{Kind: model.SessionCredential, UserID: d.session.UserID, CredentialID: d.session.ID}
			var err error
			if preview {
				err = previewFixture(t).Renew(t.Context(), d, value, p)
			} else {
				var got model.Principal
				got, err = NewIdentity("").AuthenticateBrowserActivity(t.Context(), d, value, p.UserID)
				if got != p {
					t.Fatalf("principal=%+v", got)
				}
			}
			if err != nil || d.touched != 1 {
				t.Fatalf("renew=%v writes=%d", err, d.touched)
			}
			wantUsed, wantExpiry := now, now.Add(SessionLifetime)
			if future {
				wantUsed, wantExpiry = used, expiry
			}
			if !d.used.Equal(wantUsed) || !d.expires.Equal(wantExpiry) {
				t.Fatalf("times=%v %v", d.used, d.expires)
			}
		}
	}
}

func TestBrowserActivityRefusesExpiredMissingAndChangedAccount(t *testing.T) {
	now := time.Now()
	value := secret.Random("dnst_")
	cause := errors.New("database failed")
	for _, kind := range []string{"expired", "equal", "missing", "storage", "account"} {
		d := &browserDAO{ctx: t.Context(), hash: secret.Hash(value), now: now, session: model.Session{ID: uuid.NewString(), UserID: uuid.NewString(), ExpiresAt: now.Add(time.Hour)}}
		expected := d.session.UserID
		switch kind {
		case "expired":
			d.session.ExpiresAt = now.Add(-time.Nanosecond)
		case "equal":
			d.session.ExpiresAt = now
		case "missing":
			d.lockErr = model.ErrNotFound
		case "storage":
			d.lockErr = cause
		case "account":
			expected = uuid.NewString()
		}
		got, err := NewIdentity("").AuthenticateBrowserActivity(t.Context(), d, value, expected)
		if err == nil || got != (model.Principal{}) || d.touched != 0 {
			t.Fatalf("%s result=%+v error=%v writes=%d", kind, got, err, d.touched)
		}
		if kind == "storage" && !errors.Is(err, cause) {
			t.Fatal(err)
		}
	}
	for _, input := range []struct{ value, expected string }{{"bad", ""}, {value, "invalid-id"}} {
		if _, err := NewIdentity("").AuthenticateBrowserActivity(t.Context(), &browserDAO{}, input.value, input.expected); err == nil {
			t.Fatal("invalid input accepted")
		}
	}
}

func TestPreviewActivityRechecksOriginalIdentityAndFailure(t *testing.T) {
	s := previewFixture(t)
	now := time.Now()
	value := secret.Random(previewSecretPrefix)
	cause := errors.New("write failed")
	for _, kind := range []string{"wrong-user", "wrong-session", "wrong-kind", "wrong-secret", "missing", "write"} {
		d := &browserDAO{ctx: t.Context(), hash: secret.Hash(value), preview: true, now: now, session: model.Session{ID: uuid.NewString(), UserID: uuid.NewString(), ExpiresAt: now.Add(time.Hour)}}
		p := model.Principal{Kind: model.SessionCredential, UserID: d.session.UserID, CredentialID: d.session.ID}
		input := value
		switch kind {
		case "wrong-user":
			p.UserID = uuid.NewString()
		case "wrong-session":
			p.CredentialID = uuid.NewString()
		case "wrong-kind":
			p.Kind = model.PATCredential
		case "wrong-secret":
			input = "bad"
		case "missing":
			d.lockErr = model.ErrNotFound
		case "write":
			d.touchErr = cause
		}
		err := s.Renew(t.Context(), d, input, p)
		if err == nil {
			t.Fatalf("%s accepted", kind)
		}
		if kind == "write" {
			if !errors.Is(err, cause) || d.touched != 1 {
				t.Fatal(err)
			}
		} else if d.touched != 0 {
			t.Fatalf("%s wrote", kind)
		}
	}
}
