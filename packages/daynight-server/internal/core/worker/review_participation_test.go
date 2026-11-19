package worker

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type reviewParticipationDAO struct {
	t     *testing.T
	read  func(context.Context, string, string) (model.WorkerReviewParticipation, error)
	write func(context.Context, string, string, int64, model.WorkerReviewParticipation) error
}

func (d reviewParticipationDAO) WorkerReviewParticipation(ctx context.Context, user, worker string) (model.WorkerReviewParticipation, error) {
	if d.read == nil {
		d.t.Fatal("unexpected review participation read")
	}
	return d.read(ctx, user, worker)
}
func (d reviewParticipationDAO) SetWorkerReviewParticipation(ctx context.Context, user, worker string, expected int64, next model.WorkerReviewParticipation) error {
	if d.write == nil {
		d.t.Fatal("unexpected review participation write")
	}
	return d.write(ctx, user, worker, expected, next)
}

func TestReviewParticipationVersion(t *testing.T) {
	for _, value := range []string{"", "0", "-1", "+1", "01", " 1", "1.0", "9223372036854775808"} {
		if _, err := ReviewParticipationVersion(value); err == nil {
			t.Errorf("accepted version %q", value)
		}
	}
	for _, value := range []string{"1", "9223372036854775807"} {
		if _, err := ReviewParticipationVersion(value); err != nil {
			t.Errorf("valid version %q: %v", value, err)
		}
	}
}

func TestReviewParticipationOwnerVersionAndChanges(t *testing.T) {
	p := model.Principal{UserID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential, CredentialID: "c3333333-3333-4333-8333-333333333333"}
	const id = "a1111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		name    string
		current model.WorkerReviewParticipation
		enabled bool
		next    model.WorkerReviewParticipation
	}{
		{"enable", model.WorkerReviewParticipation{Version: 1}, true, model.WorkerReviewParticipation{Enabled: true, Version: 2}},
		{"disable", model.WorkerReviewParticipation{Enabled: true, Version: 2}, false, model.WorkerReviewParticipation{Version: 3}},
		{"enabled noop", model.WorkerReviewParticipation{Enabled: true, Version: 2}, true, model.WorkerReviewParticipation{Enabled: true, Version: 2}},
		{"disabled noop", model.WorkerReviewParticipation{Version: 2}, false, model.WorkerReviewParticipation{Version: 2}},
		{"max noop", model.WorkerReviewParticipation{Enabled: true, Version: math.MaxInt64}, true, model.WorkerReviewParticipation{Enabled: true, Version: math.MaxInt64}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reads, writes := 0, 0
			check := func(ctx context.Context, u, w string) {
				if ctx != t.Context() || u != p.UserID || w != id {
					t.Fatal("wrong owner, ID or context")
				}
			}
			dao := reviewParticipationDAO{t: t, read: func(ctx context.Context, u, w string) (model.WorkerReviewParticipation, error) {
				check(ctx, u, w)
				reads++
				return tc.current, nil
			}, write: func(ctx context.Context, u, w string, expected int64, next model.WorkerReviewParticipation) error {
				check(ctx, u, w)
				writes++
				if expected != tc.current.Version || next != tc.next {
					t.Fatalf("CAS %d %+v", expected, next)
				}
				return nil
			}}
			got, err := PutReviewParticipation(t.Context(), dao, p, strings.ToUpper(id), tc.current.Version, tc.enabled)
			if err != nil || got != tc.next || reads != 1 || writes != 1 {
				t.Fatalf("got=%+v err=%v reads=%d writes=%d", got, err, reads, writes)
			}
		})
	}
}

func TestReviewParticipationRefusalsAndStoreFailures(t *testing.T) {
	const id = "a1111111-1111-4111-8111-111111111111"
	p := model.Principal{UserID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential, CredentialID: "c3333333-3333-4333-8333-333333333333"}
	failure := errors.New("storage failed")
	for _, tc := range []struct {
		name              string
		principal         model.Principal
		id                string
		current           model.WorkerReviewParticipation
		expected          int64
		enabled           bool
		readErr, writeErr error
		code              string
		cause             error
	}{
		{name: "unauthenticated", id: id, code: "unauthenticated"},
		{name: "bad id", principal: p, id: "bad", code: "invalid_input"},
		{name: "hidden", principal: p, id: id, readErr: model.ErrNotFound, code: "not_found", cause: model.ErrNotFound},
		{name: "read failure", principal: p, id: id, readErr: failure, cause: failure},
		{name: "stale noop", principal: p, id: id, current: model.WorkerReviewParticipation{Version: 2}, expected: 1, code: "version_conflict"},
		{name: "overflow", principal: p, id: id, current: model.WorkerReviewParticipation{Version: math.MaxInt64}, expected: math.MaxInt64, enabled: true, code: "version_conflict"},
		{name: "write failure", principal: p, id: id, current: model.WorkerReviewParticipation{Version: 1}, expected: 1, writeErr: failure, cause: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := reviewParticipationDAO{t: t}
			if tc.name != "unauthenticated" && tc.name != "bad id" {
				dao.read = func(context.Context, string, string) (model.WorkerReviewParticipation, error) {
					return tc.current, tc.readErr
				}
			}
			if tc.writeErr != nil {
				dao.write = func(context.Context, string, string, int64, model.WorkerReviewParticipation) error {
					return tc.writeErr
				}
			}
			got, err := PutReviewParticipation(t.Context(), dao, tc.principal, tc.id, tc.expected, tc.enabled)
			var fault *model.Fault
			if err == nil || got != (model.WorkerReviewParticipation{}) {
				t.Fatalf("refusal exposed result: %+v %v", got, err)
			}
			if tc.code != "" && (!errors.As(err, &fault) || fault.Code != tc.code) {
				t.Fatalf("want %s got %v", tc.code, err)
			}
			if tc.cause != nil && !errors.Is(err, tc.cause) {
				t.Fatalf("lost cause %v", err)
			}
		})
	}
}
