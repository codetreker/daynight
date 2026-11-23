package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestClassifyBrowserUserAgent(t *testing.T) {
	tests := []struct{ ua, browser, os string }{
		{"Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537.36 Edg/130", "Edge", "Windows"},
		{"Mozilla/5.0 (iPhone) Version/18 Mobile Safari/604.1", "Safari", "iOS"},
		{"Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36", "Chrome", "Android"},
		{"Mozilla/5.0 (Macintosh) Firefox/130", "Firefox", "macOS"},
		{"Mozilla/5.0 (X11; Linux) Chrome/130 OPR/110", "Opera", "Linux"},
		{"unknown", "", ""}, {strings.Repeat("a", 4097) + " Chrome/1 Windows NT", "", ""},
	}
	for _, tc := range tests {
		b, o := ClassifyBrowserUserAgent(tc.ua)
		if (b == nil) != (tc.browser == "") || b != nil && *b != tc.browser || (o == nil) != (tc.os == "") || o != nil && *o != tc.os {
			t.Fatalf("classification = %v %v, want %s %s", b, o, tc.browser, tc.os)
		}
	}
}

func TestCreateSessionRejectsUnboundedClassificationBeforeInsert(t *testing.T) {
	for _, tc := range []struct{ browser, os *string }{
		{browserLabel("unexpected user agent"), nil}, {nil, browserLabel("unknown platform")},
	} {
		dao := &identityDAO{}
		err := NewIdentity("").CreateSession(t.Context(), dao, model.Session{Browser: tc.browser, OS: tc.os})
		if err == nil || len(dao.calls) != 0 {
			t.Fatalf("invalid classification reached storage: %v %v", err, dao.calls)
		}
	}
}
func browserLabel(value string) *string { return &value }

type managementReadDAO struct {
	*identityDAO
	clock func(context.Context) (time.Time, error)
	read  func(context.Context, string, string, time.Time) (model.Session, error)
	list  func(context.Context, string, string, time.Time, *store.BrowserSessionPosition, int) ([]model.Session, error)
}

func (d *managementReadDAO) SessionTime(ctx context.Context) (time.Time, error) { return d.clock(ctx) }
func (d *managementReadDAO) ReadBrowserSession(ctx context.Context, user, id string, now time.Time) (model.Session, error) {
	return d.read(ctx, user, id, now)
}
func (d *managementReadDAO) ListBrowserSessions(ctx context.Context, user, current string, now time.Time, pos *store.BrowserSessionPosition, limit int) ([]model.Session, error) {
	return d.list(ctx, user, current, now, pos, limit)
}
func (*managementReadDAO) LockBrowserSessionID(context.Context, string, string) (model.Session, error) {
	panic("unexpected lock")
}
func (*managementReadDAO) DeleteBrowserSessionID(context.Context, string, string) error {
	panic("unexpected delete")
}

func TestBrowserManagementCursorValidation(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000002"}
	valid := browserCursor{Version: 1, User: p.UserID, Session: p.CredentialID, Created: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
	encode := func(v browserCursor) string {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	cases := map[string]string{"too long": strings.Repeat("a", 1025), "bad encoding": "!", "bad JSON": base64.RawURLEncoding.EncodeToString([]byte("{"))}
	for name, change := range map[string]func(*browserCursor){
		"other account":         func(c *browserCursor) { c.User = "other" },
		"other session":         func(c *browserCursor) { c.Session = "other" },
		"unsupported version":   func(c *browserCursor) { c.Version = 2 },
		"missing position time": func(c *browserCursor) { c.Created = time.Time{} },
		"invalid id":            func(c *browserCursor) { c.ID = "invalid" },
		"noncanonical id":       func(c *browserCursor) { c.ID = strings.ToUpper(c.ID) },
	} {
		c := valid
		change(&c)
		cases[name] = encode(c)
	}
	for name, cursor := range cases {
		t.Run(name, func(t *testing.T) {
			dao := &identityDAO{}
			_, err := NewIdentity("").ListBrowserSessions(t.Context(), dao, p, cursor, 10)
			checkFault(t, err, "invalid_input")
			if len(dao.calls) != 0 {
				t.Fatal("invalid cursor reached storage")
			}
		})
	}
	pos, err := parseBrowserCursor(encode(valid), p)
	if err != nil || pos == nil || pos.ID != valid.ID || !pos.CreatedAt.Equal(valid.Created) {
		t.Fatalf("cursor round trip: %+v %v", pos, err)
	}
}

func TestBrowserManagementReadsRejectAndPropagateFailures(t *testing.T) {
	ctx := t.Context()
	identity := NewIdentity("")
	p := model.Principal{Kind: model.SessionCredential, UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000002"}
	target := "00000000-0000-4000-8000-000000000003"
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	failure := errors.New("controlled storage failure")
	newDAO := func() *managementReadDAO {
		d := &managementReadDAO{identityDAO: &identityDAO{}}
		d.clock = func(context.Context) (time.Time, error) { return now, nil }
		d.read = func(_ context.Context, user, id string, stamp time.Time) (model.Session, error) {
			if user != p.UserID || !stamp.Equal(now) {
				t.Fatal("wrong account or clock")
			}
			return model.Session{ID: id, UserID: user}, nil
		}
		d.list = func(_ context.Context, user, current string, stamp time.Time, pos *store.BrowserSessionPosition, limit int) ([]model.Session, error) {
			if user != p.UserID || current != p.CredentialID || !stamp.Equal(now) || pos != nil || limit != 3 {
				t.Fatal("wrong list contract")
			}
			return []model.Session{{ID: target}}, nil
		}
		return d
	}
	t.Run("admission before storage", func(t *testing.T) {
		base := &identityDAO{}
		pat := p
		pat.Kind = model.PATCredential
		_, err := identity.ListBrowserSessions(ctx, base, pat, "", 2)
		checkFault(t, err, "forbidden")
		_, err = identity.ListBrowserSessions(ctx, base, p, "", 0)
		checkFault(t, err, "invalid_input")
		_, err = identity.GetBrowserSession(ctx, base, pat, target)
		checkFault(t, err, "forbidden")
		_, err = identity.GetBrowserSession(ctx, base, p, "invalid")
		checkFault(t, err, "invalid_input")
		if len(base.calls) != 0 {
			t.Fatal("rejected request reached storage")
		}
	})
	t.Run("missing capability", func(t *testing.T) {
		base := &identityDAO{}
		if _, err := identity.ListBrowserSessions(ctx, base, p, "", 2); err == nil || !strings.Contains(err.Error(), "management capability") {
			t.Fatalf("list: %v", err)
		}
		if _, err := identity.GetBrowserSession(ctx, base, p, target); err == nil || !strings.Contains(err.Error(), "management capability") {
			t.Fatalf("get: %v", err)
		}
	})
	t.Run("clock failure", func(t *testing.T) {
		d := newDAO()
		d.clock = func(context.Context) (time.Time, error) { return time.Time{}, failure }
		d.read = func(context.Context, string, string, time.Time) (model.Session, error) {
			t.Fatal("read after clock failure")
			return model.Session{}, nil
		}
		if _, err := identity.ListBrowserSessions(ctx, d, p, "", 2); !errors.Is(err, failure) {
			t.Fatal(err)
		}
		if _, err := identity.GetBrowserSession(ctx, d, p, target); !errors.Is(err, failure) {
			t.Fatal(err)
		}
	})
	t.Run("caller absent", func(t *testing.T) {
		d := newDAO()
		d.read = func(context.Context, string, string, time.Time) (model.Session, error) {
			return model.Session{}, model.ErrNotFound
		}
		_, err := identity.ListBrowserSessions(ctx, d, p, "", 2)
		checkFault(t, err, "unauthenticated")
		_, err = identity.GetBrowserSession(ctx, d, p, target)
		checkFault(t, err, "unauthenticated")
	})
	t.Run("list failure", func(t *testing.T) {
		d := newDAO()
		d.list = func(context.Context, string, string, time.Time, *store.BrowserSessionPosition, int) ([]model.Session, error) {
			return nil, failure
		}
		if _, err := identity.ListBrowserSessions(ctx, d, p, "", 2); !errors.Is(err, failure) {
			t.Fatal(err)
		}
	})
	for _, which := range []string{"current", "item"} {
		t.Run("invalid "+which, func(t *testing.T) {
			d := newDAO()
			bad := model.Session{OS: browserLabel("unexpected platform")}
			if which == "current" {
				d.read = func(context.Context, string, string, time.Time) (model.Session, error) { return bad, nil }
			} else {
				d.list = func(context.Context, string, string, time.Time, *store.BrowserSessionPosition, int) ([]model.Session, error) {
					return []model.Session{bad}, nil
				}
			}
			if _, err := identity.ListBrowserSessions(ctx, d, p, "", 2); err == nil || !strings.Contains(err.Error(), "classification") {
				t.Fatal(err)
			}
		})
	}
	t.Run("target failure and malformed projection", func(t *testing.T) {
		for _, test := range []struct {
			name    string
			err     error
			invalid bool
		}{{"missing", model.ErrNotFound, false}, {"database", failure, false}, {"invalid projection", nil, true}} {
			t.Run(test.name, func(t *testing.T) {
				d := newDAO()
				d.read = func(_ context.Context, _, id string, _ time.Time) (model.Session, error) {
					if id == p.CredentialID {
						return model.Session{ID: id}, nil
					}
					if test.invalid {
						return model.Session{Browser: browserLabel("unknown browser")}, nil
					}
					return model.Session{}, test.err
				}
				_, err := identity.GetBrowserSession(ctx, d, p, target)
				if test.invalid {
					if err == nil || !strings.Contains(err.Error(), "classification") {
						t.Fatal(err)
					}
				} else if test.err == model.ErrNotFound {
					checkFault(t, err, "not_found")
				} else if !errors.Is(err, failure) {
					t.Fatal(err)
				}
			})
		}
	})
	t.Run("page continuation binds last returned position", func(t *testing.T) {
		d := newDAO()
		firstID := "00000000-0000-4000-8000-000000000004"
		last := model.Session{ID: target, CreatedAt: now.Add(-time.Hour)}
		d.list = func(_ context.Context, user, current string, stamp time.Time, pos *store.BrowserSessionPosition, limit int) ([]model.Session, error) {
			if user != p.UserID || current != p.CredentialID || !stamp.Equal(now) || limit != 3 {
				t.Fatal("incorrect page scope")
			}
			if pos == nil {
				return []model.Session{{ID: firstID, CreatedAt: now}, last, {ID: "00000000-0000-4000-8000-000000000005", CreatedAt: now.Add(-2 * time.Hour)}}, nil
			}
			if pos.ID != last.ID || !pos.CreatedAt.Equal(last.CreatedAt) {
				t.Fatalf("continuation position: %+v", pos)
			}
			return []model.Session{{ID: "00000000-0000-4000-8000-000000000005"}}, nil
		}
		first, err := identity.ListBrowserSessions(ctx, d, p, "", 2)
		if err != nil || len(first.Items) != 2 || first.NextCursor == nil {
			t.Fatalf("first page %+v: %v", first, err)
		}
		second, err := identity.ListBrowserSessions(ctx, d, p, *first.NextCursor, 2)
		if err != nil || len(second.Items) != 1 || second.NextCursor != nil {
			t.Fatalf("second page %+v: %v", second, err)
		}
	})
	t.Run("successful reads", func(t *testing.T) {
		d := newDAO()
		page, err := identity.ListBrowserSessions(ctx, d, p, "", 2)
		if err != nil || page.Current.ID != p.CredentialID || len(page.Items) != 1 || page.Items[0].ID != target || page.NextCursor != nil {
			t.Fatalf("page %+v: %v", page, err)
		}
		item, err := identity.GetBrowserSession(ctx, d, p, target)
		if err != nil || item.ID != target {
			t.Fatalf("item %+v: %v", item, err)
		}
	})
}
