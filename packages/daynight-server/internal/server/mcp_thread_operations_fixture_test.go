package server

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type mcpThreadOperationPlan struct {
	t     *testing.T
	mu    sync.Mutex
	calls int
}

func (p *mcpThreadOperationPlan) called() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	if p.calls != 1 {
		p.t.Error("extra Thread operation")
	}
}
func (p *mcpThreadOperationPlan) Verify() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.calls != 1 {
		p.t.Errorf("Thread operation calls=%d, want 1", p.calls)
	}
}

type mcpThreadOperations struct {
	t    *testing.T
	mu   sync.Mutex
	post func(context.Context, model.Principal, string, string, taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error)
	list func(context.Context, model.Principal, string, string, taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error)
}

func cloneMCPThreadMessage(value model.ThreadMessage) model.ThreadMessage {
	value.Author.DisplayName = botExpiryClonePointer(value.Author.DisplayName)
	value.Author.Execution = botExpiryClonePointer(value.Author.Execution)
	value.ReplyTo = botExpiryClonePointer(value.ReplyTo)
	return value
}
func cloneMCPThreadPage(value model.ThreadPage) model.ThreadPage {
	items := make([]model.ThreadMessage, len(value.Items))
	for i := range value.Items {
		items[i] = cloneMCPThreadMessage(value.Items[i])
	}
	value.Items = items
	return value
}
func mcpThreadWireMessage(message model.ThreadMessage, details bool) map[string]any {
	author := map[string]any{"userId": message.Author.UserID, "displayName": message.Author.DisplayName, "Agent": message.Author.Agent}
	if details && message.Author.Execution != nil {
		execution := message.Author.Execution
		author["execution"] = map[string]any{"claimId": execution.ClaimID, "workerId": execution.WorkerID, "provider": execution.Provider}
	}
	value := map[string]any{"id": message.ID, "author": author, "body": message.Body, "createdAt": message.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z")}
	if message.ReplyTo != nil {
		value["replyTo"] = *message.ReplyTo
	}
	return value
}
func (o *mcpThreadOperations) expectPost(actor model.Principal, project, task string, input taskservice.CreateThreadMessage, result model.ThreadMessage, err error) *mcpThreadOperationPlan {
	expected := input
	expected.ReplyTo = botExpiryClonePointer(input.ReplyTo)
	expected.ClaimID = botExpiryClonePointer(input.ClaimID)
	message := cloneMCPThreadMessage(result)
	raw, encodeErr := json.Marshal(mcpThreadWireMessage(message, false))
	if encodeErr != nil {
		o.t.Fatal(encodeErr)
	}
	plan := &mcpThreadOperationPlan{t: o.t}
	o.t.Cleanup(plan.Verify)
	o.mu.Lock()
	defer o.mu.Unlock()
	o.post = func(ctx context.Context, p model.Principal, pid, tid string, got taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
		plan.called()
		mcpOperationContext(o.t, ctx, p)
		if p != actor || pid != project || tid != task || !reflect.DeepEqual(got, expected) {
			o.t.Errorf("Thread Post arguments changed: %+v/%s/%s/%#v", p, pid, tid, got)
		}
		if err != nil {
			return taskservice.ThreadMessageDocument{}, err
		}
		return taskservice.ThreadMessageDocument{Message: cloneMCPThreadMessage(message), JSON: append([]byte(nil), raw...)}, nil
	}
	return plan
}
func (o *mcpThreadOperations) expectList(actor model.Principal, project, task string, input taskservice.ThreadListRequest, result model.ThreadPage, err error) *mcpThreadOperationPlan {
	expected := input
	expected.BeforeID = botExpiryClonePointer(input.BeforeID)
	expected.AfterID = botExpiryClonePointer(input.AfterID)
	page := cloneMCPThreadPage(result)
	items := make([]map[string]any, len(page.Items))
	for i := range page.Items {
		items[i] = mcpThreadWireMessage(page.Items[i], input.Details)
	}
	raw, encodeErr := json.Marshal(map[string]any{"items": items, "hasMoreBefore": page.HasMoreBefore, "hasMoreAfter": page.HasMoreAfter})
	if encodeErr != nil {
		o.t.Fatal(encodeErr)
	}
	plan := &mcpThreadOperationPlan{t: o.t}
	o.t.Cleanup(plan.Verify)
	o.mu.Lock()
	defer o.mu.Unlock()
	o.list = func(ctx context.Context, p model.Principal, pid, tid string, got taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
		plan.called()
		mcpOperationContext(o.t, ctx, p)
		if p != actor || pid != project || tid != task || !reflect.DeepEqual(got, expected) {
			o.t.Errorf("Thread List arguments changed: %+v/%s/%s/%#v want %#v", p, pid, tid, got, expected)
		}
		if err != nil {
			return taskservice.ThreadPageDocument{}, err
		}
		return taskservice.ThreadPageDocument{Page: cloneMCPThreadPage(page), JSON: append([]byte(nil), raw...)}, nil
	}
	return plan
}
func (o *mcpThreadOperations) Post(ctx context.Context, p model.Principal, project, task string, input taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error) {
	o.mu.Lock()
	fn := o.post
	o.post = nil
	o.mu.Unlock()
	if fn == nil {
		o.t.Error("unconfigured or extra Thread.Post")
		return taskservice.ThreadMessageDocument{}, errors.New("unconfigured Thread.Post")
	}
	return fn(ctx, p, project, task, input)
}
func (o *mcpThreadOperations) List(ctx context.Context, p model.Principal, project, task string, input taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error) {
	o.mu.Lock()
	fn := o.list
	o.list = nil
	o.mu.Unlock()
	if fn == nil {
		o.t.Error("unconfigured or extra Thread.List")
		return taskservice.ThreadPageDocument{}, errors.New("unconfigured Thread.List")
	}
	return fn(ctx, p, project, task, input)
}
