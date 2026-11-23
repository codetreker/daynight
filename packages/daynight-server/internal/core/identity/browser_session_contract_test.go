package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestBrowserActivityExposesMissingScopeCapability(t *testing.T) {
	ctx := t.Context()
	identity := NewIdentity("")
	base := &identityDAO{}
	p, err := identity.AuthenticateBrowserActivity(ctx, base, secret.Random("dnst_"), "")
	if err == nil || err.Error() != "identity scope lacks browser session capability" || p != (model.Principal{}) || len(base.calls) != 0 {
		t.Fatalf("missing activity capability: principal=%+v error=%v calls=%v", p, err, base.calls)
	}
	err = previewFixture(t).Renew(ctx, previewDAO{}, secret.Random(previewSecretPrefix), model.Principal{Kind: model.SessionCredential})
	if err == nil || err.Error() != "identity scope lacks browser session capability" {
		t.Fatalf("missing preview renewal capability: %v", err)
	}
}

func TestSessionTimeExposesMissingScopeClock(t *testing.T) {
	stamp, err := NewIdentity("").SessionTime(t.Context(), &identityDAO{})
	if err == nil || err.Error() != "identity scope lacks browser session clock" || !stamp.IsZero() {
		t.Fatalf("missing clock: stamp=%v error=%v", stamp, err)
	}
}

func TestPreviewCreateStopsAfterSessionClockFailure(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	failure := errors.New("database clock unavailable")
	calls := 0
	dao := previewDAO{
		cleanup: func(gotCtx context.Context, gotNow time.Time) error {
			if gotCtx != ctx || gotNow != now || calls != 0 {
				t.Fatal("unexpected cleanup before database clock read")
			}
			calls++
			return nil
		},
		clock: func(gotCtx context.Context) (time.Time, error) {
			if gotCtx != ctx || calls != 1 {
				t.Fatal("unexpected database clock read")
			}
			calls++
			return time.Time{}, failure
		},
		insert: func(context.Context, model.PreviewSSOLogin) error {
			t.Fatal("clock failure issued a preview login")
			return nil
		},
	}
	login, err := previewFixture(t).Create(ctx, dao, previewTarget(), now)
	if !errors.Is(err, failure) || !reflect.DeepEqual(login, model.PreviewSSOLogin{}) || calls != 2 {
		t.Fatalf("clock failure: login=%+v error=%v calls=%d", login, err, calls)
	}
}
