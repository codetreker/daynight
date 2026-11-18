package project

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const candidateActor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const candidateTarget = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const candidateProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

type candidateScope struct {
	store.SnapshotScope
	t             *testing.T
	ctx           context.Context
	p             model.Principal
	calls         []string
	credentialErr error
	projectErr    error
	searchErr     error
	onSearch      func(context.Context)
	access        model.ProjectAccess
}

func (s *candidateScope) CredentialDAO() store.CredentialReader {
	s.calls = append(s.calls, "credentialDAO")
	return s
}
func (s *candidateScope) ProjectDAO() store.ProjectReader {
	s.calls = append(s.calls, "projectDAO")
	return candidateProjectReader{scope: s}
}
func (s *candidateScope) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	s.calls = append(s.calls, "credential")
	if ctx != s.ctx || p != s.p {
		s.t.Error("credential context or principal changed")
	}
	return store.ThreadCredential{}, s.credentialErr
}

type candidateProjectReader struct {
	store.ProjectReader
	scope *candidateScope
}

func (r candidateProjectReader) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	s := r.scope
	s.calls = append(s.calls, "project")
	if ctx != s.ctx || p != s.p || id != candidateProject {
		s.t.Error("Project context or identity changed")
	}
	return s.access, s.projectErr
}
func (s *candidateScope) UserCandidateDAO() store.UserCandidateReader {
	s.calls = append(s.calls, "candidateDAO")
	return candidateProjectReader{scope: s}
}
func (r candidateProjectReader) MemberCandidates(ctx context.Context, query store.UserCandidateQuery) (store.UserCandidatePage, error) {
	s := r.scope
	s.calls = append(s.calls, "search")
	if ctx != s.ctx || query.Query != "alice" || query.Limit != 20 || query.AfterID != nil {
		s.t.Errorf("unexpected query: %+v", query)
	}
	if s.onSearch != nil {
		s.onSearch(ctx)
		return store.UserCandidatePage{}, ctx.Err()
	}
	return store.UserCandidatePage{Items: []model.UserCandidate{{UserID: candidateTarget}}}, s.searchErr
}

type candidateSnapshot struct {
	database
	scope      *candidateScope
	completion error
	calls      int
}

func (s *candidateSnapshot) ReadSnapshot(ctx context.Context, op func(store.SnapshotScope) error) error {
	s.calls++
	if ctx != s.scope.ctx {
		s.scope.t.Error("snapshot context changed")
	}
	err := op(s.scope)
	if s.completion != nil {
		return s.completion
	}
	return err
}

func TestCandidateSearchSnapshotAdmissionAndCompletion(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential, model.OAuthCredential} {
		t.Run(string(kind), func(t *testing.T) {
			ctx := context.WithValue(context.Background(), struct{}{}, "context")
			p := model.Principal{UserID: candidateActor, CredentialID: candidateTarget, Kind: kind}
			scope := &candidateScope{t: t, ctx: ctx, p: p, access: model.ProjectAccess{Role: model.ProjectAdmin}}
			snapshot := &candidateSnapshot{scope: scope}
			svc := &Memberships{store: snapshot}
			page, err := svc.SearchMemberCandidates(ctx, p, candidateProject, core.CandidateSearchInput{ExpectedUserID: p.UserID, Query: " ALICE "})
			if err != nil || len(page.Items) != 1 || page.Items[0].UserID != candidateTarget || snapshot.calls != 1 || !reflect.DeepEqual(scope.calls, []string{"credentialDAO", "credential", "projectDAO", "candidateDAO", "project", "search"}) {
				t.Fatalf("page=%+v err=%v calls=%v", page, err, scope.calls)
			}
		})
	}
	for _, tc := range []struct {
		name                                             string
		query                                            string
		credentialErr, projectErr, searchErr, completion error
		role                                             model.ProjectRole
		wantCode                                         string
		wantCalls                                        []string
	}{
		{"empty", "  ", nil, nil, nil, nil, model.ProjectAdmin, "", []string{"credentialDAO", "credential", "projectDAO", "candidateDAO", "project"}},
		{"revoked", "alice", model.ErrNotFound, nil, nil, nil, model.ProjectAdmin, "unauthenticated", []string{"credentialDAO", "credential"}},
		{"credential-failed", "alice", errors.New("credential failure"), nil, nil, nil, model.ProjectAdmin, "internal", []string{"credentialDAO", "credential"}},
		{"missing", "alice", nil, model.ErrNotFound, nil, nil, model.ProjectAdmin, "not_found", []string{"credentialDAO", "credential", "projectDAO", "candidateDAO", "project"}},
		{"demoted", "alice", nil, nil, nil, nil, model.ProjectMemberRole, "forbidden", []string{"credentialDAO", "credential", "projectDAO", "candidateDAO", "project"}},
		{"search-failed", "alice", nil, nil, errors.New("search failure"), nil, model.ProjectAdmin, "internal", []string{"credentialDAO", "credential", "projectDAO", "candidateDAO", "project", "search"}},
		{"cleanup-discards-directory", "alice", nil, nil, nil, errors.New("cleanup failure"), model.ProjectAdmin, "completion", []string{"credentialDAO", "credential", "projectDAO", "candidateDAO", "project", "search"}},
		{"cleanup-precedes-refusal", "alice", model.ErrNotFound, nil, nil, errors.New("cleanup failure"), model.ProjectAdmin, "completion", []string{"credentialDAO", "credential"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			p := model.Principal{UserID: candidateActor, CredentialID: candidateTarget, Kind: model.PATCredential}
			access := model.ProjectAccess{Role: tc.role}
			scope := &candidateScope{t: t, ctx: ctx, p: p, access: access, credentialErr: tc.credentialErr, projectErr: tc.projectErr, searchErr: tc.searchErr}
			snapshot := &candidateSnapshot{scope: scope, completion: tc.completion}
			page, err := (&Memberships{store: snapshot}).SearchMemberCandidates(ctx, p, candidateProject, core.CandidateSearchInput{ExpectedUserID: p.UserID, Query: tc.query})
			if !reflect.DeepEqual(scope.calls, tc.wantCalls) || snapshot.calls != 1 {
				t.Fatalf("calls=%v", scope.calls)
			}
			if tc.wantCode == "" {
				if err != nil || page.Items == nil || len(page.Items) != 0 {
					t.Fatalf("page=%+v err=%v", page, err)
				}
			} else if tc.wantCode == "completion" || tc.wantCode == "internal" {
				want := tc.completion
				if want == nil {
					want = tc.searchErr
				}
				if want == nil {
					want = tc.credentialErr
				}
				if !errors.Is(err, want) || len(page.Items) != 0 {
					t.Fatalf("page=%+v err=%v", page, err)
				}
			} else {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != tc.wantCode || len(page.Items) != 0 {
					t.Fatalf("page=%+v err=%v", page, err)
				}
			}
		})
	}
}

func TestCandidateSearchRejectsIdentityBeforeSnapshot(t *testing.T) {
	p := model.Principal{UserID: candidateActor, CredentialID: candidateTarget, Kind: model.PATCredential}
	snapshot := &candidateSnapshot{}
	_, err := (&Memberships{store: snapshot}).SearchMemberCandidates(context.Background(), p, candidateProject, core.CandidateSearchInput{ExpectedUserID: candidateTarget, Query: "alice"})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "identity_mismatch" || snapshot.calls != 0 {
		t.Fatalf("err=%v snapshots=%d", err, snapshot.calls)
	}
}

func TestCandidateSearchPropagatesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := model.Principal{UserID: candidateActor, CredentialID: candidateTarget, Kind: model.PATCredential}
	started := make(chan struct{})
	scope := &candidateScope{t: t, ctx: ctx, p: p, access: model.ProjectAccess{Role: model.ProjectAdmin}, onSearch: func(ctx context.Context) {
		close(started)
		<-ctx.Done()
	}}
	snapshot := &candidateSnapshot{scope: scope}
	done := make(chan error, 1)
	go func() {
		_, err := (&Memberships{store: snapshot}).SearchMemberCandidates(ctx, p, candidateProject, core.CandidateSearchInput{ExpectedUserID: p.UserID, Query: "alice"})
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("search did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("search did not stop")
	}
}
