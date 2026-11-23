package github

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func validAppInput() CreateAppInput {
	return CreateAppInput{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Name: "示例 App", GitHubAppID: 42, PrivateKeyPEM: "key", WebhookSecret: "secret", ExpectedUserID: principal.UserID}
}

func TestValidateCreateApp(t *testing.T) {
	for _, tc := range []struct {
		name   string
		actor  model.Principal
		change func(*CreateAppInput)
		code   string
	}{
		{"valid", principal, func(*CreateAppInput) {}, ""},
		{"anonymous first", model.Principal{}, func(i *CreateAppInput) { i.ID = "bad" }, "unauthenticated"},
		{"missing expected identity", principal, func(i *CreateAppInput) { i.ExpectedUserID = "" }, "invalid_input"},
		{"other identity", principal, func(i *CreateAppInput) { i.ExpectedUserID = projectID }, "identity_mismatch"},
		{"bad UUID", principal, func(i *CreateAppInput) { i.ID = "bad" }, "invalid_input"},
		{"uppercase UUID", principal, func(i *CreateAppInput) { i.ID = strings.ToUpper(i.ID) }, "invalid_input"},
		{"zero github ID", principal, func(i *CreateAppInput) { i.GitHubAppID = 0 }, "invalid_input"},
		{"negative github ID", principal, func(i *CreateAppInput) { i.GitHubAppID = -1 }, "invalid_input"},
		{"empty name", principal, func(i *CreateAppInput) { i.Name = "" }, "invalid_input"},
		{"unicode whitespace name", principal, func(i *CreateAppInput) { i.Name = "\u2003\u00a0" }, "invalid_input"},
		{"NUL name", principal, func(i *CreateAppInput) { i.Name = "a\x00b" }, "invalid_input"},
		{"invalid UTF8 name", principal, func(i *CreateAppInput) { i.Name = "a\xff" }, "invalid_input"},
		{"name codepoint limit", principal, func(i *CreateAppInput) { i.Name = strings.Repeat("a", 256) }, ""},
		{"name too many codepoints", principal, func(i *CreateAppInput) { i.Name = strings.Repeat("a", 257) }, "invalid_input"},
		{"name byte limit", principal, func(i *CreateAppInput) { i.Name = strings.Repeat("🙂", 256) }, ""},
		{"name byte overflow", principal, func(i *CreateAppInput) { i.Name = strings.Repeat("🙂", 257) }, "invalid_input"},
		{"empty PEM", principal, func(i *CreateAppInput) { i.PrivateKeyPEM = "" }, "invalid_input"},
		{"PEM byte limit", principal, func(i *CreateAppInput) { i.PrivateKeyPEM = strings.Repeat("a", 65536) }, ""},
		{"PEM overflow", principal, func(i *CreateAppInput) { i.PrivateKeyPEM = strings.Repeat("a", 65537) }, "invalid_input"},
		{"invalid UTF8 PEM", principal, func(i *CreateAppInput) { i.PrivateKeyPEM = "\xff" }, "invalid_input"},
		{"empty secret", principal, func(i *CreateAppInput) { i.WebhookSecret = "" }, "invalid_input"},
		{"whitespace secret preserved", principal, func(i *CreateAppInput) { i.WebhookSecret = " " }, ""},
		{"secret byte limit", principal, func(i *CreateAppInput) { i.WebhookSecret = strings.Repeat("a", 4096) }, ""},
		{"secret overflow", principal, func(i *CreateAppInput) { i.WebhookSecret = strings.Repeat("a", 4097) }, "invalid_input"},
		{"invalid UTF8 secret", principal, func(i *CreateAppInput) { i.WebhookSecret = "\xff" }, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := validAppInput()
			tc.change(&in)
			err := ValidateCreateApp(tc.actor, in)
			if tc.code == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
			} else {
				faultCode(t, err, tc.code)
			}
		})
	}
}

func TestValidateAppRead(t *testing.T) {
	id := validAppInput().ID
	if err := ValidateAppRead(principal, id); err != nil {
		t.Fatal(err)
	}
	faultCode(t, ValidateAppRead(model.Principal{}, "bad"), "unauthenticated")
	faultCode(t, ValidateAppRead(principal, strings.ToUpper(id)), "invalid_input")
	faultCode(t, ValidateAppRead(principal, "bad"), "invalid_input")
}

type appReadFixture struct {
	wantCtx context.Context
	calls   int
	query   store.GitHubAppQuery
	result  store.GitHubAppPage
	err     error
}

func (f *appReadFixture) Get(context.Context, string, string) (githubpr.AppMetadata, error) {
	panic("unexpected Get")
}
func (f *appReadFixture) List(ctx context.Context, q store.GitHubAppQuery) (store.GitHubAppPage, error) {
	if ctx != f.wantCtx {
		panic("incorrect context")
	}
	f.calls++
	f.query = q
	return f.result, f.err
}

func TestListAppsActorPaginationAndErrors(t *testing.T) {
	ctx := context.Background()
	created := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	item := githubpr.AppMetadata{ID: validAppInput().ID, GitHubAppID: 42, Name: "App", GitHubName: "Remote", GitHubSlug: "app", Version: 2, Administrators: 3, AuthorizedTeams: 4, ConnectedProjects: 5, CreatedAt: created, UpdatedAt: created}
	f := &appReadFixture{wantCtx: ctx, result: store.GitHubAppPage{Items: []githubpr.AppMetadata{item}, HasMore: true}}
	page, err := ListApps(ctx, f, principal, ListAppsInput{})
	if err != nil || f.calls != 1 || f.query.ActorID != principal.UserID || f.query.Limit != 25 || f.query.After != nil || !reflect.DeepEqual(page.Items, []githubpr.AppMetadata{item}) || page.NextCursor == nil {
		t.Fatalf("first page %+v query %+v error %v", page, f.query, err)
	}
	cursor := *page.NextCursor
	f.result = store.GitHubAppPage{}
	page, err = ListApps(ctx, f, principal, ListAppsInput{Limit: 100, Cursor: cursor})
	if err != nil || f.query.Limit != 100 || f.query.After == nil || f.query.After.ID != item.ID || !f.query.After.CreatedAt.Equal(created) || page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("next page %+v query %+v error %v", page, f.query, err)
	}
	other := principal
	other.UserID = projectID
	calls := f.calls
	_, err = ListApps(ctx, f, other, ListAppsInput{Cursor: cursor})
	faultCode(t, err, "invalid_input")
	if f.calls != calls {
		t.Fatal("other actor cursor reached DAO")
	}
	for _, input := range []ListAppsInput{{Limit: -1}, {Limit: 101}, {Cursor: "not a cursor"}} {
		_, err = ListApps(ctx, f, principal, input)
		faultCode(t, err, "invalid_input")
		if f.calls != calls {
			t.Fatal("invalid input reached DAO")
		}
	}
	_, err = ListApps(ctx, f, model.Principal{}, ListAppsInput{})
	faultCode(t, err, "unauthenticated")
	if f.calls != calls {
		t.Fatal("anonymous read reached DAO")
	}
	cause := errors.New("storage failed")
	f.err = cause
	page, err = ListApps(ctx, f, principal, ListAppsInput{})
	if !errors.Is(err, cause) || !reflect.DeepEqual(page, AppPage{}) {
		t.Fatalf("DAO failure: %+v %v", page, err)
	}
}
