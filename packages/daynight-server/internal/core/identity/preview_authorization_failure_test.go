package identity

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestPreviewAuthorizationRejectsMalformedBrowserBinding(t *testing.T) {
	state := secret.Random("")
	for _, input := range []struct{ id, state string }{{"invalid", state}, {previewLogin, "invalid"}} {
		authorization, err := previewFixture(t).Authorize(t.Context(), previewDAO{}, input.id, input.state, model.Principal{Kind: model.SessionCredential}, time.Now())
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "unauthenticated" || authorization != (PreviewSSOAuthorization{}) {
			t.Fatalf("invalid binding: authorization=%+v error=%v", authorization, err)
		}
	}
}

func TestPreviewAuthorizationStorageFailuresNeverExposeCode(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	issuedAt := now.Add(time.Minute)
	state := secret.Random("")
	principal := model.Principal{Kind: model.SessionCredential, UserID: "owner", CredentialID: "session"}
	for _, stage := range []string{"cleanup", "set"} {
		for _, cause := range []error{errors.New("database unavailable"), model.ErrNotFound, context.Canceled} {
			t.Run(stage+"/"+cause.Error(), func(t *testing.T) {
				var calls []string
				dao := previewDAO{
					cleanup: func(gotCtx context.Context, gotNow time.Time) error {
						if gotCtx != ctx || gotNow != now {
							t.Fatal("cleanup identity changed")
						}
						calls = append(calls, "cleanup")
						if stage == "cleanup" {
							return cause
						}
						return nil
					},
					lockAuthorization: func(gotCtx context.Context, id string, hash []byte, got model.Principal, gotNow time.Time) (time.Time, error) {
						if gotCtx != ctx || id != previewLogin || !bytes.Equal(hash, secret.Hash(state)) || got != principal || gotNow != now {
							t.Fatal("authorization lock binding changed")
						}
						calls = append(calls, "lock")
						return issuedAt, nil
					},
					setAuthorization: func(gotCtx context.Context, id string, got model.Principal, hash []byte, expires time.Time) error {
						if gotCtx != ctx || id != previewLogin || got != principal || len(hash) != 32 || !expires.Equal(issuedAt.Add(PreviewCodeLifetime)) {
							t.Fatal("authorization issuance binding changed")
						}
						calls = append(calls, "set")
						return cause
					},
				}
				authorization, err := previewFixture(t).Authorize(ctx, dao, previewLogin, state, principal, now)
				wantCalls := []string{"cleanup"}
				if stage == "set" {
					wantCalls = append(wantCalls, "lock", "set")
				}
				if !errors.Is(err, cause) || authorization != (PreviewSSOAuthorization{}) || !reflect.DeepEqual(calls, wantCalls) {
					t.Fatalf("failed authorization: result=%+v error=%v calls=%v", authorization, err, calls)
				}
			})
		}
	}
}
