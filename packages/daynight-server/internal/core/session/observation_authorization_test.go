package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type observationCredentialReader struct {
	t     *testing.T
	want  model.Principal
	err   error
	calls int
}

func (r *observationCredentialReader) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	r.calls++
	if p != r.want {
		r.t.Fatalf("credential actor changed: %#v", p)
	}
	if err := ctx.Err(); err != nil {
		return store.ThreadCredential{}, err
	}
	return store.ThreadCredential{}, r.err
}
func TestTaskObservationAuthorizationRechecksRealCredentials(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.OAuthCredential, model.SessionCredential} {
		t.Run(string(kind), func(t *testing.T) {
			_, p, _, _ := observationFixture(t)
			p.Kind = kind
			reader := &observationCredentialReader{t: t, want: p}
			if err := AuthorizeTaskObservation(t.Context(), reader, p); err != nil {
				t.Fatal(err)
			}
			reader.err = model.ErrNotFound
			err := AuthorizeTaskObservation(t.Context(), reader, p)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" || !errors.Is(err, model.ErrNotFound) || reader.calls != 2 {
				t.Fatalf("revocation not preserved: calls=%d err=%v", reader.calls, err)
			}
			reader.err = errors.New("credential storage unavailable")
			if err := AuthorizeTaskObservation(t.Context(), reader, p); !errors.Is(err, reader.err) {
				t.Fatalf("credential cause lost: %v", err)
			}
		})
	}
}
func TestNativeCredentialHelperRequiresPurposeAwareOAuthAdmission(t *testing.T) {
	_, p, _, _ := observationFixture(t)
	p.Kind = model.OAuthCredential
	if err := credential(t.Context(), nil, p, time.Now()); err == nil {
		t.Fatal("native credential helper accepted OAuth without family validation")
	}
}

func TestTaskObservationAuthorizationRejectsInvalidActorAndCancellation(t *testing.T) {
	reader := &observationCredentialReader{t: t}
	if err := AuthorizeTaskObservation(t.Context(), reader, model.Principal{}); err == nil || reader.calls != 0 {
		t.Fatalf("invalid actor reached reader: calls=%d err=%v", reader.calls, err)
	}
	_, p, _, _ := observationFixture(t)
	reader.want = p
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := AuthorizeTaskObservation(ctx, reader, p); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}
