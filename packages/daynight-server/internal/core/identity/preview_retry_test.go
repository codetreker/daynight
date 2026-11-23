package identity

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestPreviewRetryValidatesAndReplacesTarget(t *testing.T) {
	s := previewFixture(t)
	now := time.Now().UTC()
	p := model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "session"}
	state := secret.Random("")
	target := previewTarget() + "?a=%2F&b=two+words"
	for _, mode := range []string{"id", "state", "both"} {
		id, suppliedState := previewLogin, ""
		if mode == "state" {
			id, suppliedState = "", state
		} else if mode == "both" {
			suppliedState = state
		}
		calls := 0
		d := previewDAO{clock: func(context.Context) (time.Time, error) { return now, nil }, retry: func(_ context.Context, gotID string, gotHash []byte, gotP model.Principal, gotNow time.Time) (model.PreviewSSOLogin, error) {
			calls++
			if gotID != id || gotP != p || gotNow != now || (suppliedState != "" && !bytes.Equal(gotHash, secret.Hash(state))) || (suppliedState == "" && len(gotHash) != 0) {
				t.Fatal("incorrect retry identity")
			}
			return model.PreviewSSOLogin{ID: previewLogin, ReturnURL: target}, nil
		}, insert: func(_ context.Context, login model.PreviewSSOLogin) error {
			calls++
			if !canonicalUUID(login.ID) || login.ID == previewLogin || login.ReturnURL != target || login.ExpiresAt.Before(now.Add(LoginLifetime)) || len(login.StateHash) != 0 {
				t.Fatalf("replacement: %+v", login)
			}
			return nil
		}}
		newID, err := s.Retry(t.Context(), d, id, suppliedState, p, now)
		if err != nil || !canonicalUUID(newID) || calls != 2 {
			t.Fatalf("retry %q %v calls=%d", newID, err, calls)
		}
	}
	for _, tc := range []struct {
		id, state string
		principal model.Principal
	}{{"", "", p}, {"invalid", "", p}, {previewLogin, "bad", p}, {"", "bad", p}, {previewLogin, "", model.Principal{Kind: model.PATCredential}}} {
		if _, err := s.Retry(t.Context(), previewDAO{}, tc.id, tc.state, tc.principal, now); err == nil {
			t.Fatalf("accepted invalid retry: %+v", tc)
		}
	}
	failure := errors.New("storage failed")
	d := previewDAO{retry: func(context.Context, string, []byte, model.Principal, time.Time) (model.PreviewSSOLogin, error) {
		return model.PreviewSSOLogin{}, failure
	}}
	if id, err := s.Retry(t.Context(), d, previewLogin, "", p, now); id != "" || !errors.Is(err, failure) {
		t.Fatal(id, err)
	}
	d.retry = func(context.Context, string, []byte, model.Principal, time.Time) (model.PreviewSSOLogin, error) {
		return model.PreviewSSOLogin{ReturnURL: "https://outside.test/"}, nil
	}
	if id, err := s.Retry(t.Context(), d, previewLogin, "", p, now); id != "" || err == nil {
		t.Fatal(id, err)
	}
	d.retry = func(context.Context, string, []byte, model.Principal, time.Time) (model.PreviewSSOLogin, error) {
		return model.PreviewSSOLogin{ReturnURL: target}, nil
	}
	d.insert = func(context.Context, model.PreviewSSOLogin) error { return failure }
	d.clock = func(context.Context) (time.Time, error) { return now, nil }
	if id, err := s.Retry(t.Context(), d, previewLogin, "", p, now); id != "" || !errors.Is(err, failure) {
		t.Fatal(id, err)
	}
}
