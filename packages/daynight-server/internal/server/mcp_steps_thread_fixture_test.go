package server

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const mcpStepsProjectID = "c3333333-3333-4333-8333-333333333333"
const mcpStepsTaskID = "d4444444-4444-4444-8444-444444444444"

func mcpStepsCheck(t *testing.T, ok bool, message string, values ...any) {
	t.Helper()
	if !ok {
		t.Errorf(message, values...)
		panic("MCP DAO expectation failed")
	}
}

type mcpStepsPageExpectation struct {
	After   int64
	Limit   int
	Summary bool
	Rows    []store.TaskStepProjection
}

type mcpStepsReadPlan struct {
	t            *testing.T
	plan         *httpCallPlan
	Header       model.TaskHeader
	Principal    model.Principal
	AccessError  error
	Pages        []mcpStepsPageExpectation
	SummaryID    string
	Summary      store.TaskStepProjection
	SummaryError error
	pageIndex    int
}

func (p *mcpStepsReadPlan) snapshot(tx *httpTestStore) {
	s := newHTTPTestSnapshot(p.t)
	s.Projects = &mcpStepsProjectReader{mcpStepsRejectedProjectReader{p.t}, p}
	s.Tasks = &mcpStepsReader{mcpStepsRejectedTaskReader{p.t}, p}
	tx.ReadSnapshotCall = func(ctx context.Context, read func(store.SnapshotScope) error) error {
		p.plan.Called("snapshot")
		mcpStepsCheck(p.t, ctx.Err() == nil && read != nil, "invalid Step snapshot callback")
		return read(s)
	}
}

type mcpStepsProjectReader struct {
	mcpStepsRejectedProjectReader
	p *mcpStepsReadPlan
}

func (r *mcpStepsProjectReader) ProjectAccess(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	r.p.plan.Called("access")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && principal == r.p.Principal && projectID == r.p.Header.ProjectID, "Step read access changed actor/address: %+v %s", principal, projectID)
	return model.ProjectAccess{ProjectID: projectID, UserID: principal.UserID, Role: model.ProjectAdmin}, r.p.AccessError
}

type mcpStepsReader struct {
	mcpStepsRejectedTaskReader
	p *mcpStepsReadPlan
}

func (r *mcpStepsReader) TaskHeader(ctx context.Context, projectID, taskID string) (model.TaskHeader, error) {
	r.p.plan.Called("header")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && projectID == r.p.Header.ProjectID && taskID == r.p.Header.ID, "Step read changed header scope: %s/%s", projectID, taskID)
	return r.p.Header, nil
}

func (r *mcpStepsReader) TaskStepPage(ctx context.Context, taskID string, after int64, limit int, summary bool) ([]store.TaskStepProjection, error) {
	r.p.plan.Called("page")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.Header.ID && r.p.pageIndex < len(r.p.Pages), "unexpected Step page: %s/%d/%d/%v", taskID, after, limit, summary)
	p := r.p.Pages[r.p.pageIndex]
	r.p.pageIndex++
	mcpStepsCheck(r.p.t, after == p.After && limit == p.Limit && summary == p.Summary, "Step page bounds/projection: %d/%d/%v want %d/%d/%v", after, limit, summary, p.After, p.Limit, p.Summary)
	return slices.Clone(p.Rows), nil
}

func (r *mcpStepsReader) TaskStep(ctx context.Context, taskID, stepID string) (model.TaskStep, error) {
	r.p.plan.Called("step")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.Header.ID && stepID == r.p.SummaryID, "Step read scope: %s/%s", taskID, stepID)
	return r.p.Summary.Step, r.p.SummaryError
}

func (r *mcpStepsReader) TaskStepSummary(ctx context.Context, taskID, stepID string) (store.TaskStepProjection, error) {
	r.p.plan.Called("summary")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.Header.ID && stepID == r.p.SummaryID, "Step summary scope: %s/%s", taskID, stepID)
	return r.p.Summary, r.p.SummaryError
}

type mcpStepsWritePlan struct {
	t           *testing.T
	plan        *httpCallPlan
	Header      model.TaskHeader
	PostHeader  model.TaskHeader
	Principal   model.Principal
	AccessError error
	Rows        []model.TaskStep
	Observed    time.Time
	Mutation    string
	Step        model.TaskStep
	From, To    int64
	Completion  store.Completion
	order       []string
	headerReads int
}

func (p *mcpStepsWritePlan) write(tx *httpTestStore) {
	tx.WriteProjectCall = func(ctx context.Context, projectID string, write func(store.ProjectWriteScope) error) (store.Completion, error) {
		p.plan.Called("write")
		mcpStepsCheck(p.t, ctx.Err() == nil && projectID == p.Header.ProjectID && write != nil, "Step write scope changed: %s", projectID)
		err := write(&mcpStepsWriteScope{p: p})
		return p.Completion, err
	}
}

func (p *mcpStepsWritePlan) called(name string) {
	p.plan.Called(name)
	p.order = append(p.order, name)
}

type mcpStepsWriteScope struct{ p *mcpStepsWritePlan }

func (s *mcpStepsWriteScope) ProjectDAO() store.ProjectWriteDAO {
	return &mcpStepsProjectWriter{mcpStepsRejectedProjectWriteDAO{s.p.t}, s.p}
}
func (s *mcpStepsWriteScope) TaskDAO() store.TaskWriteDAO {
	return &mcpStepsWriter{mcpStepsRejectedTaskWriteDAO{s.p.t}, s.p}
}
func (s *mcpStepsWriteScope) CaptureDAO() store.WebhookCaptureDAO {
	return &mcpStepsCapture{mcpStepsRejectedWebhookCaptureDAO{s.p.t}, s.p}
}
func (s *mcpStepsWriteScope) EligibilityDAO() store.WebhookEligibilityDAO {
	unexpectedHTTPCall(s.p.t, "Step.EligibilityDAO")
	panic("unreachable")
}
func (s *mcpStepsWriteScope) SessionDAO() store.ProjectSessionDAO {
	unexpectedHTTPCall(s.p.t, "Step.SessionDAO")
	panic("unreachable")
}

type mcpStepsProjectWriter struct {
	mcpStepsRejectedProjectWriteDAO
	p *mcpStepsWritePlan
}

func (w *mcpStepsProjectWriter) ProjectAccess(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
	w.p.called("access")
	mcpStepsCheck(w.p.t, ctx.Err() == nil && principal == w.p.Principal, "Step writer principal: %+v", principal)
	return model.ProjectAccess{ProjectID: w.p.Header.ProjectID, UserID: principal.UserID, Role: model.ProjectAdmin}, w.p.AccessError
}

type mcpStepsWriter struct {
	mcpStepsRejectedTaskWriteDAO
	p *mcpStepsWritePlan
}

func (w *mcpStepsWriter) TaskHeader(ctx context.Context, taskID string) (model.TaskHeader, error) {
	w.p.called("header")
	mcpStepsCheck(w.p.t, ctx.Err() == nil && taskID == w.p.Header.ID, "Step writer header identity: %s", taskID)
	w.p.headerReads++
	if w.p.headerReads == 1 {
		return w.p.Header, nil
	}
	return w.p.PostHeader, nil
}
func (w *mcpStepsWriter) TaskSteps(ctx context.Context, taskID string) ([]model.TaskStep, error) {
	w.p.called("rows")
	mcpStepsCheck(w.p.t, ctx.Err() == nil && taskID == w.p.Header.ID, "Step writer collection identity: %s", taskID)
	return slices.Clone(w.p.Rows), nil
}
func (w *mcpStepsWriter) ObservedAt(ctx context.Context) (time.Time, error) {
	w.p.called("clock")
	mcpStepsCheck(w.p.t, ctx.Err() == nil, "Step writer clock context canceled")
	return w.p.Observed, nil
}
func (w *mcpStepsWriter) InsertTaskStep(ctx context.Context, taskID string, step model.TaskStep) error {
	return w.mutate(ctx, taskID, step, "insert")
}
func (w *mcpStepsWriter) UpdateTaskStep(ctx context.Context, taskID string, step model.TaskStep) error {
	return w.mutate(ctx, taskID, step, "update")
}
func (w *mcpStepsWriter) mutate(ctx context.Context, taskID string, step model.TaskStep, operation string) error {
	w.p.called(operation)
	mcpStepsCheck(w.p.t, ctx.Err() == nil && taskID == w.p.Header.ID && w.p.Mutation == operation && step == w.p.Step, "Step %s arguments: %+v want %+v", operation, step, w.p.Step)
	return nil
}
func (w *mcpStepsWriter) MoveTaskStep(ctx context.Context, taskID, stepID string, from, to int64) error {
	w.p.called("move")
	mcpStepsCheck(w.p.t, ctx.Err() == nil && taskID == w.p.Header.ID && stepID == w.p.Step.ID && from == w.p.From && to == w.p.To && w.p.Mutation == "move", "Step move changed identity/positions: %s/%d/%d", stepID, from, to)
	return nil
}
func (w *mcpStepsWriter) DeleteTaskStep(ctx context.Context, taskID, stepID string, from, count int64) error {
	w.p.called("delete")
	mcpStepsCheck(w.p.t, ctx.Err() == nil && taskID == w.p.Header.ID && stepID == w.p.Step.ID && from == w.p.From && count == w.p.To && w.p.Mutation == "delete", "Step delete changed identity/shift count: %s/%d/%d", stepID, from, count)
	return nil
}
func (w *mcpStepsWriter) TouchTask(ctx context.Context, taskID string, at time.Time) error {
	w.p.called("touch")
	mcpStepsCheck(w.p.t, ctx.Err() == nil && taskID == w.p.Header.ID && at == w.p.Observed, "Step touch changed identity/clock: %s/%v", taskID, at)
	return nil
}

type mcpStepsCapture struct {
	mcpStepsRejectedWebhookCaptureDAO
	p *mcpStepsWritePlan
}

func (c *mcpStepsCapture) FreezeAudience(ctx context.Context, projectID string, eventTypes []string) ([]store.WebhookAudience, error) {
	c.p.called("capture")
	mcpStepsCheck(c.p.t, ctx.Err() == nil && projectID == c.p.Header.ProjectID && reflect.DeepEqual(eventTypes, []string{"task.step_updated"}), "Step capture changed Project/event type: %s/%v", projectID, eventTypes)
	return []store.WebhookAudience{}, nil
}

type mcpThreadWritePlan struct {
	t          *testing.T
	plan       *httpCallPlan
	Principal  model.Principal
	TaskID     string
	Source     model.Task
	Head       *model.ThreadPosition
	ReplyID    string
	Reply      model.ThreadMessage
	ReplyError error
	Input      model.ThreadMessage
	Inserted   model.ThreadMessage
	Completion store.Completion
	order      []string
}

func (p *mcpThreadWritePlan) called(name string) {
	p.plan.Called(name)
	p.order = append(p.order, name)
}

func (p *mcpThreadWritePlan) write(tx *httpTestStore) {
	p.Source = mcpCloneFixture(p.Source)
	p.Head = mcpCloneFixture(p.Head)
	p.Reply = mcpCloneFixture(p.Reply)
	p.Input = mcpCloneFixture(p.Input)
	p.Inserted = mcpCloneFixture(p.Inserted)
	tx.WriteThreadCall = func(ctx context.Context, write func(store.ThreadScope) error) (store.Completion, error) {
		p.called("write")
		mcpStepsCheck(p.t, ctx.Err() == nil && write != nil, "invalid Thread write callback")
		err := write(&mcpThreadWriteScope{p: p})
		return p.Completion, err
	}
}

type mcpThreadWriteScope struct{ p *mcpThreadWritePlan }

func (s *mcpThreadWriteScope) TaskDAO() store.ThreadTaskDAO             { return s }
func (s *mcpThreadWriteScope) CredentialDAO() store.ThreadCredentialDAO { return s }
func (s *mcpThreadWriteScope) ProjectDAO() store.ThreadProjectDAO       { return s }
func (s *mcpThreadWriteScope) ThreadDAO() store.ThreadDAO               { return s }
func (s *mcpThreadWriteScope) CaptureDAO() store.WebhookCaptureDAO {
	return &mcpThreadCapture{mcpStepsRejectedWebhookCaptureDAO{s.p.t}, s.p}
}
func (s *mcpThreadWriteScope) LockTaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	s.p.called("presence")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && projectID == mcpStepsProjectID && taskID == s.p.TaskID, "Thread presence scope: %s/%s", projectID, taskID)
	return store.TaskPresence{Found: true}, nil
}
func (s *mcpThreadWriteScope) SourceTask(ctx context.Context, projectID, taskID string) (model.Task, error) {
	s.p.called("source")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && projectID == mcpStepsProjectID && taskID == s.p.TaskID && s.p.Source.ID == taskID, "Thread claim source changed: %s/%s", projectID, taskID)
	return mcpCloneFixture(s.p.Source), nil
}
func (s *mcpThreadWriteScope) Credential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	s.p.called("credential")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && principal == s.p.Principal, "Thread credential actor: %+v", principal)
	return store.ThreadCredential{}, nil
}
func (s *mcpThreadWriteScope) CredentialValid(ctx context.Context, credential store.ThreadCredential) (bool, error) {
	s.p.called("valid")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && credential.ExpiresAt == nil, "Thread final credential changed")
	return true, nil
}
func (s *mcpThreadWriteScope) AuthorName(ctx context.Context, userID string) (*string, error) {
	s.p.called("name")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && userID == s.p.Principal.UserID, "Thread author identity: %s", userID)
	return mcpCloneFixture(s.p.Input.Author.DisplayName), nil
}
func (s *mcpThreadWriteScope) LockProjectAuthorization(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	s.p.called("access")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && principal == s.p.Principal && projectID == mcpStepsProjectID, "Thread Project admission changed")
	return model.ProjectAccess{ProjectID: projectID, UserID: principal.UserID, Role: model.ProjectAdmin}, nil
}
func (s *mcpThreadWriteScope) LockHead(ctx context.Context, taskID string) (*model.ThreadPosition, error) {
	s.p.called("head")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && taskID == s.p.TaskID, "Thread head identity: %s", taskID)
	return mcpCloneFixture(s.p.Head), nil
}
func (s *mcpThreadWriteScope) ThreadMessage(ctx context.Context, taskID, id string) (model.ThreadMessage, error) {
	s.p.called("reply")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && taskID == s.p.TaskID && id == s.p.ReplyID, "Thread reply scope: %s/%s", taskID, id)
	return mcpCloneFixture(s.p.Reply), s.p.ReplyError
}
func (s *mcpThreadWriteScope) InsertMessage(ctx context.Context, message model.ThreadMessage) (model.ThreadMessage, error) {
	s.p.called("insert")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && reflect.DeepEqual(message, s.p.Input), "Thread insert changed body/author/reply: %+v want %+v", message, s.p.Input)
	return mcpCloneFixture(s.p.Inserted), nil
}
func (s *mcpThreadWriteScope) PrepareTimestamp(ctx context.Context, message *model.ThreadMessage, head *model.ThreadPosition) error {
	s.p.called("clock")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && message != nil && reflect.DeepEqual(*message, s.p.Inserted) && reflect.DeepEqual(head, s.p.Head), "Thread timestamp did not use the inserted message and admitted head")
	return nil
}
func (s *mcpThreadWriteScope) AdvanceHead(ctx context.Context, taskID string, position model.ThreadPosition) error {
	s.p.called("advance")
	mcpStepsCheck(s.p.t, ctx.Err() == nil && taskID == s.p.TaskID && position == s.p.Inserted.Position(), "Thread advance changed message position: %s/%+v", taskID, position)
	return nil
}

type mcpThreadCapture struct {
	mcpStepsRejectedWebhookCaptureDAO
	p *mcpThreadWritePlan
}

func (c *mcpThreadCapture) FreezeAudience(ctx context.Context, projectID string, eventTypes []string) ([]store.WebhookAudience, error) {
	c.p.called("capture")
	mcpStepsCheck(c.p.t, ctx.Err() == nil && projectID == mcpStepsProjectID && reflect.DeepEqual(eventTypes, []string{"task.thread_posted"}), "Thread capture changed Project/type: %s/%v", projectID, eventTypes)
	return []store.WebhookAudience{}, nil
}

type mcpThreadReadPlan struct {
	t                     *testing.T
	plan                  *httpCallPlan
	Principal             model.Principal
	TaskID                string
	AccessError           error
	AnchorID              string
	Anchor                model.ThreadMessage
	Before                bool
	Limit                 int
	Candidates            []model.ThreadMessage
	First, Last           model.ThreadPosition
	MoreBefore, MoreAfter bool
}

func (p *mcpThreadReadPlan) snapshot(tx *httpTestStore) {
	p.Anchor = mcpCloneFixture(p.Anchor)
	p.Candidates = mcpCloneFixture(p.Candidates)
	s := newHTTPTestSnapshot(p.t)
	s.Credentials = &mcpThreadReadCredential{p}
	s.Projects = &mcpThreadReadProject{mcpStepsRejectedProjectReader{p.t}, p}
	s.Tasks = &mcpThreadReader{mcpStepsRejectedTaskReader{p.t}, p}
	tx.ReadSnapshotCall = func(ctx context.Context, read func(store.SnapshotScope) error) error {
		p.plan.Called("snapshot")
		mcpStepsCheck(p.t, ctx.Err() == nil && read != nil, "invalid Thread snapshot callback")
		return read(s)
	}
}

type mcpThreadReadCredential struct{ p *mcpThreadReadPlan }

func (r *mcpThreadReadCredential) Credential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	r.p.plan.Called("credential")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && principal == r.p.Principal, "Thread read credential actor changed: %+v", principal)
	return store.ThreadCredential{}, nil
}

type mcpThreadReadProject struct {
	mcpStepsRejectedProjectReader
	p *mcpThreadReadPlan
}

func (r *mcpThreadReadProject) ProjectAccess(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	r.p.plan.Called("access")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && principal == r.p.Principal && projectID == mcpStepsProjectID, "Thread read Project actor/scope changed")
	return model.ProjectAccess{ProjectID: projectID, UserID: principal.UserID, Role: model.ProjectAdmin}, r.p.AccessError
}

type mcpThreadReader struct {
	mcpStepsRejectedTaskReader
	p *mcpThreadReadPlan
}

func (r *mcpThreadReader) TaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	r.p.plan.Called("presence")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && projectID == mcpStepsProjectID && taskID == r.p.TaskID, "Thread read presence changed: %s/%s", projectID, taskID)
	return store.TaskPresence{Found: true}, nil
}
func (r *mcpThreadReader) ThreadMessage(ctx context.Context, taskID, id string) (model.ThreadMessage, error) {
	r.p.plan.Called("anchor")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.TaskID && id == r.p.AnchorID, "Thread read anchor changed: %s/%s", taskID, id)
	return mcpCloneFixture(r.p.Anchor), nil
}
func (r *mcpThreadReader) ThreadCandidates(ctx context.Context, taskID string, anchor *model.ThreadPosition, before bool, limit int) ([]model.ThreadMessage, error) {
	r.p.plan.Called("candidates")
	var expected *model.ThreadPosition
	if r.p.AnchorID != "" {
		position := r.p.Anchor.Position()
		expected = &position
	}
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.TaskID && reflect.DeepEqual(anchor, expected) && before == r.p.Before && limit == r.p.Limit, "Thread candidate scope/bounds: %s/%+v/%v/%d", taskID, anchor, before, limit)
	return mcpCloneFixture(r.p.Candidates), nil
}
func (r *mcpThreadReader) ThreadSides(ctx context.Context, taskID string, first, last model.ThreadPosition) (bool, bool, error) {
	r.p.plan.Called("sides")
	mcpStepsCheck(r.p.t, ctx.Err() == nil && taskID == r.p.TaskID && first == r.p.First && last == r.p.Last, "Thread page sides changed identity/positions: %s/%+v/%+v", taskID, first, last)
	return r.p.MoreBefore, r.p.MoreAfter, nil
}

func mcpStepProjection(rows ...model.TaskStep) []store.TaskStepProjection {
	out := make([]store.TaskStepProjection, len(rows))
	for i, row := range rows {
		out[i] = store.TaskStepProjection{Step: row}
	}
	return out
}
