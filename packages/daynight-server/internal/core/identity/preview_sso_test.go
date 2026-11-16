package identity

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

const (
	previewMain     = "https://daynight.cc"
	previewBase     = "https://preview.daynight.cc"
	previewCallback = "https://daynight.cc/api/v1/auth/callback"
	previewLogin    = "db2e62fc-21b8-4e31-bdd2-c9e6d7f0ed4e"
	previewTask     = "14f700f3-d745-4df9-a3a6-fbc403d266cc"
	previewProject  = "a0da78a6-e482-43b1-ae95-ecc956a0ef2b"
)

func previewFixture(t *testing.T) *PreviewSSO {
	t.Helper()
	s, err := NewPreviewSSO(previewMain, previewBase, previewCallback)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func previewTarget() string {
	return "https://" + previewTask + ".preview.daynight.cc/api/v1/projects/" + previewProject + "/tasks/" + previewTask + "/preview/a%20b/index.html"
}

func TestPreviewReturnTargets(t *testing.T) {
	s := previewFixture(t)
	complete := previewMain + "/auth/complete?returnPath=%2Fprojects%3Fq%3Da%252Fb%23part&callbackPath=%2Fapi%2Fv1%2Fauth%2Fcallback"
	for _, v := range []string{previewMain + "/projects?x=%2F&x=2", previewMain + "/projects?" + strings.Repeat("q", MaxReturnPathBytes+1), complete, previewTarget() + "?a=%2F&b=1", previewTarget() + "?" + strings.Repeat("q", transport.MaxRawQueryBytes)} {
		if err := s.ValidateReturnURL(v); err != nil {
			t.Errorf("valid %q: %v", v[:min(len(v), 160)], err)
		}
	}
	base := previewTarget()
	for _, v := range []string{
		"https://evil.example/projects", previewMain + "/login", previewMain + "/auth/sso/start", previewMain + "/auth/%73so/start", previewMain + "/other%2F..%2Fauth%2Fsso/start", previewMain + "/auth/complete?returnPath=%2Fprojects", complete + "&returnPath=%2Ffoo", strings.Replace(complete, "callback", "wrong", 1),
		previewMain + "/auth/complete?returnPath=" + url.QueryEscape("/"+strings.Repeat("a", MaxReturnPathBytes)) + "&callbackPath=%2Fapi%2Fv1%2Fauth%2Fcallback",
		base + "#fragment", base + "?" + strings.Repeat("q", transport.MaxRawQueryBytes+1), strings.Replace(base, previewTask+".preview", "other."+previewTask+".preview", 1), strings.Replace(base, "/tasks/"+previewTask, "/tasks/"+previewProject, 1), strings.Replace(base, "/a%20b/", "/a%2fb/", 1), strings.Replace(base, "/a%20b/", "/%2e%2e/", 1), base + "\n",
	} {
		if err := s.ValidateReturnURL(v); err == nil {
			t.Errorf("accepted %q", v[:min(len(v), 160)])
		}
	}
	prefix := "https://" + previewTask + ".preview.daynight.cc"
	path := "/api/v1/projects/" + previewProject + "/tasks/" + previewTask + "/preview/"
	exact := prefix + path + strings.Repeat("x", transport.MaxRequestTargetBytes-len(path))
	if err := s.ValidateReturnURL(exact); err != nil {
		t.Fatalf("exact target: %v", err)
	}
	if err := s.ValidateReturnURL(exact + "x"); err == nil {
		t.Fatal("oversized target accepted")
	}
}

type previewDAO struct {
	cleanup           func(context.Context, time.Time) error
	insert            func(context.Context, model.PreviewSSOLogin) error
	start             func(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error)
	lockAuthorization func(context.Context, string, []byte, model.Principal, time.Time) (time.Time, error)
	setAuthorization  func(context.Context, string, model.Principal, []byte, time.Time) error
	redeem            func(context.Context, []byte, []byte, []byte, time.Time) (model.PreviewSSOLogin, model.Session, error)
	complete          func(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error)
	retry             func(context.Context, string, []byte, model.Principal, time.Time) (model.PreviewSSOLogin, error)
	authenticate      func(context.Context, []byte, time.Time) (model.Principal, time.Time, error)
}

func (d previewDAO) CleanupPreviewSSO(c context.Context, n time.Time) error { return d.cleanup(c, n) }
func (d previewDAO) InsertPreviewSSO(c context.Context, l model.PreviewSSOLogin) error {
	return d.insert(c, l)
}
func (d previewDAO) StartPreviewSSO(c context.Context, id string, h []byte, n time.Time) (model.PreviewSSOLogin, error) {
	return d.start(c, id, h, n)
}
func (d previewDAO) LockPreviewAuthorization(c context.Context, id string, h []byte, p model.Principal, n time.Time) (time.Time, error) {
	return d.lockAuthorization(c, id, h, p, n)
}
func (d previewDAO) SetPreviewAuthorization(c context.Context, id string, p model.Principal, code []byte, e time.Time) error {
	return d.setAuthorization(c, id, p, code, e)
}
func (d previewDAO) RedeemPreviewSSO(c context.Context, code, state, h []byte, n time.Time) (model.PreviewSSOLogin, model.Session, error) {
	return d.redeem(c, code, state, h, n)
}
func (d previewDAO) CompletePreviewSSO(c context.Context, id string, h []byte, n time.Time) (model.PreviewSSOLogin, error) {
	return d.complete(c, id, h, n)
}
func (d previewDAO) TakePreviewSSORetry(c context.Context, id string, h []byte, p model.Principal, n time.Time) (model.PreviewSSOLogin, error) {
	return d.retry(c, id, h, p, n)
}
func (d previewDAO) AuthenticatePreview(c context.Context, h []byte, n time.Time) (model.Principal, time.Time, error) {
	return d.authenticate(c, h, n)
}

func TestPreviewSSOLifecycleOperations(t *testing.T) {
	s := previewFixture(t)
	ctx := context.WithValue(context.Background(), struct{}{}, "context")
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	want := previewTarget() + "?x=%2f&x=2"
	principal := model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "session"}
	var login model.PreviewSSOLogin
	d := previewDAO{cleanup: func(c context.Context, n time.Time) error {
		if c != ctx || n != now {
			t.Fatal("cleanup context/time")
		}
		return nil
	}, insert: func(c context.Context, l model.PreviewSSOLogin) error {
		if c != ctx {
			t.Fatal("insert context")
		}
		login = l
		return nil
	}}
	created, err := s.Create(ctx, d, want, now)
	if err != nil || created.ID != login.ID || !canonicalUUID(login.ID) || login.ReturnURL != want || login.ExpiresAt.Before(now.Add(LoginLifetime)) || login.ExpiresAt.After(now.Add(LoginLifetime+time.Second)) || len(login.StateHash) != 0 {
		t.Fatalf("create: %+v %v", login, err)
	}
	d.start = func(c context.Context, id string, h []byte, n time.Time) (model.PreviewSSOLogin, error) {
		if c != ctx || id != login.ID || n != now {
			t.Fatal("start input")
		}
		login.StateHash = h
		return login, nil
	}
	start, err := s.Start(ctx, d, login.ID, now)
	if err != nil || !bytes.Equal(login.StateHash, secret.Hash(start.State)) || start.LoginID != login.ID {
		t.Fatalf("start: %+v %v", start, err)
	}
	var codeHash []byte
	issuedAt := now.Add(3 * time.Second)
	d.lockAuthorization = func(c context.Context, id string, h []byte, p model.Principal, n time.Time) (time.Time, error) {
		if c != ctx || id != login.ID || p != principal || !bytes.Equal(h, login.StateHash) || n.Before(now) || n.After(now.Add(time.Second)) {
			t.Fatal("authorization lock input")
		}
		return issuedAt, nil
	}
	d.setAuthorization = func(c context.Context, id string, p model.Principal, code []byte, e time.Time) error {
		if c != ctx || id != login.ID || p != principal || !e.Equal(issuedAt.Add(time.Minute)) {
			t.Fatal("authorization write input")
		}
		codeHash = code
		return nil
	}
	auth, err := s.Authorize(ctx, d, login.ID, start.State, principal, now)
	if err != nil || !bytes.Equal(codeHash, secret.Hash(auth.Code)) || !auth.ExpiresAt.Equal(issuedAt.Add(time.Minute)) {
		t.Fatalf("authorize: %+v %v", auth, err)
	}
	var previewHash []byte
	expiry := now.Add(time.Hour)
	d.redeem = func(c context.Context, code, state, h []byte, n time.Time) (model.PreviewSSOLogin, model.Session, error) {
		if c != ctx || n != now || !bytes.Equal(code, codeHash) || !bytes.Equal(state, login.StateHash) {
			t.Fatal("redeem input")
		}
		previewHash = h
		return login, model.Session{ID: principal.CredentialID, UserID: principal.UserID, ExpiresAt: expiry}, nil
	}
	r, err := s.Redeem(ctx, d, auth.Code, start.State, start.State, now)
	if err != nil || r.LoginID != login.ID || !r.ExpiresAt.Equal(expiry) || !bytes.Equal(previewHash, secret.Hash(r.Secret)) {
		t.Fatalf("redeem: %+v %v", r, err)
	}
	d.complete = func(c context.Context, id string, h []byte, n time.Time) (model.PreviewSSOLogin, error) {
		if c != ctx || id != login.ID || n != now || !bytes.Equal(h, previewHash) {
			t.Fatal("complete input")
		}
		return login, nil
	}
	got, err := s.Complete(ctx, d, login.ID, r.Secret, now)
	if err != nil || got != want {
		t.Fatalf("complete %q %v", got, err)
	}
	d.authenticate = func(c context.Context, h []byte, n time.Time) (model.Principal, time.Time, error) {
		if c != ctx || n != now || !bytes.Equal(h, previewHash) {
			t.Fatal("auth input")
		}
		return principal, expiry, nil
	}
	p, e, err := s.Authenticate(ctx, d, r.Secret, now)
	if err != nil || p != principal || !e.Equal(expiry) {
		t.Fatalf("authenticate: %+v %v %v", p, e, err)
	}
}

func TestPreviewSSORejectsAndPropagatesErrors(t *testing.T) {
	s := previewFixture(t)
	now := time.Now()
	state, code := secret.Random(""), secret.Random("")
	p := model.Principal{Kind: model.SessionCredential}
	if _, err := s.Redeem(context.Background(), previewDAO{}, code, state, secret.Random(""), now); err == nil {
		t.Fatal("mismatched browser binding accepted")
	}
	if _, err := s.Authorize(context.Background(), previewDAO{}, previewLogin, state, model.Principal{Kind: model.PATCredential}, now); err == nil {
		t.Fatal("PAT accepted")
	}
	failure := errors.New("storage failure")
	for _, cause := range []error{model.ErrNotFound, failure, context.Canceled} {
		d := previewDAO{cleanup: func(context.Context, time.Time) error { return nil }, lockAuthorization: func(context.Context, string, []byte, model.Principal, time.Time) (time.Time, error) {
			return time.Time{}, cause
		}, redeem: func(context.Context, []byte, []byte, []byte, time.Time) (model.PreviewSSOLogin, model.Session, error) {
			return model.PreviewSSOLogin{}, model.Session{}, cause
		}, complete: func(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error) {
			return model.PreviewSSOLogin{}, cause
		}, authenticate: func(context.Context, []byte, time.Time) (model.Principal, time.Time, error) {
			return model.Principal{}, time.Time{}, cause
		}}
		if _, err := s.Authorize(context.Background(), d, previewLogin, state, p, now); !errors.Is(err, cause) {
			t.Errorf("authorize: %v", err)
		}
		if _, err := s.Redeem(context.Background(), d, code, state, state, now); !errors.Is(err, cause) {
			t.Errorf("redeem: %v", err)
		}
		if _, err := s.Complete(context.Background(), d, previewLogin, secret.Random(previewSecretPrefix), now); !errors.Is(err, cause) {
			t.Errorf("complete: %v", err)
		}
		if _, _, err := s.Authenticate(context.Background(), d, secret.Random(previewSecretPrefix), now); !errors.Is(err, cause) {
			t.Errorf("authenticate: %v", err)
		}
	}
}

func TestPreviewAuthorizationCountsCleanupTime(t *testing.T) {
	s := previewFixture(t)
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var lockTime time.Time
	d := previewDAO{
		cleanup: func(context.Context, time.Time) error { time.Sleep(15 * time.Millisecond); return nil },
		lockAuthorization: func(_ context.Context, _ string, _ []byte, _ model.Principal, n time.Time) (time.Time, error) {
			lockTime = n
			return n, nil
		},
		setAuthorization: func(_ context.Context, _ string, _ model.Principal, _ []byte, _ time.Time) error { return nil },
	}
	auth, err := s.Authorize(context.Background(), d, previewLogin, secret.Random(""), model.Principal{Kind: model.SessionCredential}, now)
	if err != nil || lockTime.Before(now.Add(15*time.Millisecond)) || !auth.ExpiresAt.Equal(lockTime.Add(time.Minute)) {
		t.Fatalf("cleanup timing: %v %v %v", lockTime, auth.ExpiresAt, err)
	}
}

func TestPreviewCreateRejectsTargetAndStorageFailures(t *testing.T) {
	s := previewFixture(t)
	ctx, now := context.Background(), time.Now()
	if result, err := s.Create(ctx, previewDAO{}, "https://evil.example/", now); err == nil || result.ID != "" {
		t.Fatalf("invalid target: %+v %v", result, err)
	}
	failure := errors.New("storage unavailable")
	for _, tc := range []struct {
		name string
		dao  previewDAO
	}{
		{"cleanup", previewDAO{cleanup: func(context.Context, time.Time) error { return failure }}},
		{"insert", previewDAO{
			cleanup: func(context.Context, time.Time) error { return nil },
			insert:  func(context.Context, model.PreviewSSOLogin) error { return failure },
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := s.Create(ctx, tc.dao, previewMain+"/projects", now)
			if !errors.Is(err, failure) || result.ID != "" {
				t.Fatalf("create: %+v %v", result, err)
			}
		})
	}
}

func TestPreviewStartAndCompleteRejectUnusableRecords(t *testing.T) {
	s := previewFixture(t)
	ctx, now := context.Background(), time.Now()
	credential := secret.Random(previewSecretPrefix)
	if start, err := s.Start(ctx, previewDAO{}, "bad-id", now); err == nil || start.State != "" {
		t.Fatalf("invalid start ID: %+v %v", start, err)
	}
	if target, err := s.Complete(ctx, previewDAO{}, previewLogin, "bad-secret", now); err == nil || target != "" {
		t.Fatalf("invalid completion credential: %q %v", target, err)
	}
	if principal, expiry, err := s.Authenticate(ctx, previewDAO{}, "bad-secret", now); err == nil || principal != (model.Principal{}) || !expiry.IsZero() {
		t.Fatalf("invalid preview credential: %+v %v %v", principal, expiry, err)
	}
	for _, cause := range []error{model.ErrNotFound, context.Canceled} {
		d := previewDAO{start: func(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error) {
			return model.PreviewSSOLogin{}, cause
		}}
		if start, err := s.Start(ctx, d, previewLogin, now); !errors.Is(err, cause) || start.State != "" {
			t.Errorf("start failed lookup: %+v %v", start, err)
		}
	}
	bad := model.PreviewSSOLogin{ID: previewLogin, ReturnURL: "https://evil.example/"}
	d := previewDAO{
		start:    func(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error) { return bad, nil },
		complete: func(context.Context, string, []byte, time.Time) (model.PreviewSSOLogin, error) { return bad, nil },
	}
	if start, err := s.Start(ctx, d, previewLogin, now); err == nil || start.State != "" {
		t.Errorf("start with invalid stored target: %+v %v", start, err)
	}
	if target, err := s.Complete(ctx, d, previewLogin, credential, now); err == nil || target != "" {
		t.Errorf("complete with invalid stored target: %q %v", target, err)
	}
}

func TestPreviewReturnTargetRequiresConfiguredPort(t *testing.T) {
	s, err := NewPreviewSSO("http://main.local:8080", "http://preview.local:8081", "http://main.local:8080/api/v1/auth/callback")
	if err != nil {
		t.Fatal(err)
	}
	target := "http://" + previewTask + ".preview.local:8081/api/v1/projects/" + previewProject + "/tasks/" + previewTask + "/preview/a%20b.html?x=%2F"
	if err := s.ValidateReturnURL(target); err != nil {
		t.Fatalf("configured preview port: %v", err)
	}
	for _, invalid := range []string{strings.Replace(target, ":8081", ":8082", 1), strings.Replace(target, ":8081", "", 1)} {
		if err := s.ValidateReturnURL(invalid); err == nil {
			t.Errorf("accepted different preview port: %q", invalid)
		}
	}
}

func TestPreviewSSORejectsInvalidConfiguration(t *testing.T) {
	for _, tc := range []struct{ main, preview, callback string }{
		{"https://daynight.cc/path", previewBase, previewCallback},
		{previewMain, "https://preview.daynight.cc?extra=1", previewCallback},
		{previewMain, previewBase, "https://evil.example/api/v1/auth/callback"},
		{previewMain, previewBase, previewCallback + "?query=1"},
	} {
		if result, err := NewPreviewSSO(tc.main, tc.preview, tc.callback); err == nil || result != nil {
			t.Errorf("invalid configuration accepted: %+v %v", result, err)
		}
	}
}
