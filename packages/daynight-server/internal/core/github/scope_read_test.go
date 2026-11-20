package github

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func readAuthorization(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	p, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &p}
}

func TestPullRequestScopeFollowsProjectVisibilityInSnapshot(t *testing.T) {
	ctx := context.Background()
	denied := readAuthorization(t, "github:read")
	permitted := readAuthorization(t, "project:read")
	request := ListRequest{State: "active", Limit: 5}
	f := fixtureFor(ctx)
	f.accessErr = model.ErrNotFound
	_, err := NewReader(f, true).ListAuthorized(ctx, denied, projectID, request)
	faultCode(t, err, "not_found")
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access"}) {
		t.Fatalf("trace %v", f.trace)
	}

	f = fixtureFor(ctx)
	_, err = NewReader(f, true).ListAuthorized(ctx, denied, projectID, request)
	faultCode(t, err, "insufficient_scope")
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access"}) {
		t.Fatalf("scope refusal read GitHub data: %v", f.trace)
	}

	f = fixtureFor(ctx)
	_, err = NewReader(f, true).ListAuthorized(ctx, permitted, projectID, request)
	if err != nil || !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection", "counts", "list"}) {
		t.Fatalf("trace %v err %v", f.trace, err)
	}
}

func TestAllPullRequestOperationsRefuseMissingProjectScope(t *testing.T) {
	ctx := context.Background()
	auth := readAuthorization(t, "github:read")
	cases := map[string]func(*Reader) error{
		"list": func(r *Reader) error {
			_, e := r.ListAuthorized(ctx, auth, projectID, ListRequest{State: "active", Limit: 1})
			return e
		},
		"detail": func(r *Reader) error { _, e := r.DetailAuthorized(ctx, auth, projectID, 42, nil); return e },
		"review": func(r *Reader) error { _, e := r.ReviewAssignmentAuthorized(ctx, auth, projectID, 42, nil); return e },
		"repositories": func(r *Reader) error {
			_, e := r.RepositoriesAuthorized(ctx, auth, projectID, RepositoriesRequest{Limit: 1})
			return e
		},
		"authors": func(r *Reader) error {
			_, e := r.AuthorsAuthorized(ctx, auth, projectID, AuthorsRequest{Limit: 1})
			return e
		},
		"statistics": func(r *Reader) error {
			_, e := r.StatisticsAuthorized(ctx, auth, projectID, validStatisticsRequest())
			return e
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			f := fixtureFor(ctx)
			err := run(NewReader(f, true))
			faultCode(t, err, "insufficient_scope")
			want := []string{"snapshot", "access"}
			if name == "detail" || name == "review" {
				want = append(want, "pr-visibility")
			}
			if !reflect.DeepEqual(f.trace, want) {
				t.Fatalf("trace %v", f.trace)
			}
		})
	}
}

func TestScopedPullRequestMissingRemainsNotFound(t *testing.T) {
	ctx := context.Background()
	auth := readAuthorization(t, "github:read")
	for _, run := range []func(*Reader) error{
		func(r *Reader) error { _, err := r.DetailAuthorized(ctx, auth, projectID, 42, nil); return err },
		func(r *Reader) error {
			_, err := r.ReviewAssignmentAuthorized(ctx, auth, projectID, 42, nil)
			return err
		},
	} {
		f := fixtureFor(ctx)
		f.visibilityErr = model.ErrNotFound
		err := run(NewReader(f, true))
		faultCode(t, err, "not_found")
		if !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "pr-visibility"}) {
			t.Fatalf("trace %v", f.trace)
		}
	}
}

func TestScopedPullRequestMissingRepositoryRetainsOriginalError(t *testing.T) {
	ctx := context.Background()
	auth := readAuthorization(t, "github:read")
	repo := int64(123)
	f := fixtureFor(ctx)
	f.repositoryVisibilityErr = model.ErrNotFound
	_, err := NewReader(f, true).DetailAuthorized(ctx, auth, projectID, 42, &repo)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "not_found" || fault.Message != "Pull request repository was not found." {
		t.Fatalf("got %v", err)
	}
	if !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "repository-visibility"}) {
		t.Fatalf("trace %v", f.trace)
	}
}

func TestScopedCollectionsHideMissingRepositoryBeforeScope(t *testing.T) {
	ctx := context.Background()
	auth := readAuthorization(t, "github:read")
	repo := int64(123)
	statistics := validStatisticsRequest()
	statistics.RepositoryID = &repo
	for name, run := range map[string]func(*Reader) error{
		"list": func(r *Reader) error {
			_, err := r.ListAuthorized(ctx, auth, projectID, ListRequest{State: "active", Limit: 1, RepositoryID: &repo})
			return err
		},
		"authors": func(r *Reader) error {
			_, err := r.AuthorsAuthorized(ctx, auth, projectID, AuthorsRequest{Limit: 1, RepositoryID: &repo})
			return err
		},
		"statistics": func(r *Reader) error { _, err := r.StatisticsAuthorized(ctx, auth, projectID, statistics); return err },
	} {
		t.Run(name, func(t *testing.T) {
			f := fixtureFor(ctx)
			f.repositoryVisibilityErr = model.ErrNotFound
			err := run(NewReader(f, true))
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "not_found" || fault.Message != "Pull request repository was not found." {
				t.Fatalf("got %v", err)
			}
			if !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "repository-visibility"}) {
				t.Fatalf("trace %v", f.trace)
			}
		})
	}
}

func TestPullRequestAuthorizedRejectsInvalidCredentialBeforeReading(t *testing.T) {
	ctx := t.Context()
	auth := readAuthorization(t, "project:read")
	auth.Policy = nil
	f := fixtureFor(ctx)
	r := NewReader(f, true)
	operations := map[string]func() error{
		"list": func() error {
			_, err := r.ListAuthorized(ctx, auth, projectID, ListRequest{State: "active", Limit: 1})
			return err
		},
		"detail":     func() error { _, err := r.DetailAuthorized(ctx, auth, projectID, 42, nil); return err },
		"assignment": func() error { _, err := r.ReviewAssignmentAuthorized(ctx, auth, projectID, 42, nil); return err },
		"repositories": func() error {
			_, err := r.RepositoriesAuthorized(ctx, auth, projectID, RepositoriesRequest{Limit: 1})
			return err
		},
		"authors": func() error {
			_, err := r.AuthorsAuthorized(ctx, auth, projectID, AuthorsRequest{Limit: 1})
			return err
		},
		"statistics": func() error {
			_, err := r.StatisticsAuthorized(ctx, auth, projectID, validStatisticsRequest())
			return err
		},
	}
	for name, operation := range operations {
		if err := operation(); err == nil {
			t.Errorf("%s accepted missing policy", name)
		}
	}
	if len(f.trace) != 0 {
		t.Fatalf("invalid credential read resources: %v", f.trace)
	}
}
