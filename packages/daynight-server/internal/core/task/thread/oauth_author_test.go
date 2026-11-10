package thread

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type oauthAuthorDAO struct {
	store.ThreadTaskDAO
	store.ThreadCredentialDAO
	store.ThreadDAO
	t         *testing.T
	ctx       context.Context
	principal model.Principal
	task      string
	now       time.Time
	events    []string
}

func (d *oauthAuthorDAO) called(ctx context.Context, event string) {
	d.t.Helper()
	if ctx != d.ctx || ctx.Err() != nil {
		d.t.Fatalf("%s context: %v", event, ctx.Err())
	}
	d.events = append(d.events, event)
}

func (d *oauthAuthorDAO) SourceTask(context.Context, string, string) (model.Task, error) {
	d.t.Fatal("OAuth author without an execution must not read SourceTask")
	return model.Task{}, nil
}

func (d *oauthAuthorDAO) AuthorName(ctx context.Context, user string) (*string, error) {
	d.called(ctx, "author")
	if user != d.principal.UserID {
		d.t.Fatalf("author user: %s", user)
	}
	name := "OAuth author"
	return &name, nil
}

func (d *oauthAuthorDAO) LockHead(ctx context.Context, task string) (*model.ThreadPosition, error) {
	d.called(ctx, "head")
	if task != d.task {
		d.t.Fatalf("head task: %s", task)
	}
	return nil, nil
}

func (d *oauthAuthorDAO) expected(id string, at time.Time) model.ThreadMessage {
	name := "OAuth author"
	return model.ThreadMessage{ID: id, TaskID: d.task, Author: model.ThreadAuthor{UserID: d.principal.UserID, DisplayName: &name}, Body: "OAuth author", CreatedAt: at}
}

func (d *oauthAuthorDAO) InsertMessage(ctx context.Context, message model.ThreadMessage) (model.ThreadMessage, error) {
	d.called(ctx, "insert")
	if !reflect.DeepEqual(message, d.expected("", time.Time{})) {
		d.t.Fatalf("complete OAuth candidate: %+v", message)
	}
	return d.expected("d7777777-7777-4777-8777-777777777777", time.Time{}), nil
}

func (d *oauthAuthorDAO) PrepareTimestamp(ctx context.Context, message *model.ThreadMessage, head *model.ThreadPosition) error {
	d.called(ctx, "time")
	if head != nil || !reflect.DeepEqual(*message, d.expected("d7777777-7777-4777-8777-777777777777", time.Time{})) {
		d.t.Fatalf("complete timestamp input: message=%+v head=%+v", message, head)
	}
	message.CreatedAt = d.now
	return nil
}

func (d *oauthAuthorDAO) CredentialValid(ctx context.Context, credential store.ThreadCredential) (bool, error) {
	d.called(ctx, "valid")
	if credential.ExpiresAt == nil || !credential.ExpiresAt.Equal(d.now.Add(time.Hour)) {
		d.t.Fatalf("credential recheck: %+v", credential)
	}
	return true, nil
}

func (d *oauthAuthorDAO) AdvanceHead(ctx context.Context, task string, position model.ThreadPosition) error {
	d.called(ctx, "advance")
	if task != d.task || position != (model.ThreadPosition{ID: "d7777777-7777-4777-8777-777777777777", CreatedAt: d.now}) {
		d.t.Fatalf("head advancement: %s %+v", task, position)
	}
	return nil
}

func TestAppendOAuthAuthorWithoutExecutionAttribution(t *testing.T) {
	ctx := t.Context()
	p := model.Principal{Kind: model.OAuthCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "f6666666-6666-4666-8666-666666666666"}
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	dao := &oauthAuthorDAO{t: t, ctx: ctx, principal: p, task: "e2222222-2222-4222-8222-222222222222", now: now}
	expiry := now.Add(time.Hour)
	message, encoded, err := Append(ctx, dao, dao, dao, p, "d1111111-1111-4111-8111-111111111111", dao.task, "OAuth author", nil, nil, store.ThreadCredential{ExpiresAt: &expiry})
	expected := dao.expected("d7777777-7777-4777-8777-777777777777", now)
	if err != nil || !reflect.DeepEqual(message, expected) {
		t.Fatalf("complete message: %+v error=%v", message, err)
	}
	var wire struct {
		ID, Body  string
		Author    model.ThreadAuthor
		CreatedAt time.Time
	}
	if err := json.Unmarshal(encoded, &wire); err != nil || wire.ID != expected.ID || wire.Body != expected.Body || !reflect.DeepEqual(wire.Author, expected.Author) || !wire.CreatedAt.Equal(now) {
		t.Fatalf("OAuth message encoding: %s error=%v", encoded, err)
	}
	if !slices.Equal(dao.events, []string{"author", "head", "insert", "time", "valid", "advance"}) {
		t.Fatalf("OAuth append order: %v", dao.events)
	}
}
