package task

import (
	"errors"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
)

func TestTaskStepsDeletePreservesSurvivorsParentAndExecutionPolicies(t *testing.T) {
	original := orderedStepRows()
	current := original
	for i, tc := range []struct {
		target     string
		from, tail int64
		order      []string
	}{
		{"ABCDEF01", 2, 1, []string{"00000000", "11111111", "fedcba98"}}, {"00000000", 0, 2, []string{"11111111", "fedcba98"}},
		{"FEDCBA98", 1, 0, []string{"11111111"}}, {"11111111", 0, 0, []string{}},
	} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			h := writeHeader(int64(i + 1))
			before := slices.Clone(current)
			candidate := orderStepRows(t, original, tc.order)
			expected := slices.Clone(candidate)
			if candidate != nil && expected == nil {
				expected = []model.TaskStep{}
			}
			f := newOrderedWrite(t, h, current)
			f.target = strings.ToLower(tc.target)
			f.from, f.to = tc.from, tc.tail
			f.mutation = tasksteps.Mutation{Candidate: candidate, From: int(tc.from), Changed: true}
			f.fact("deleted", orderedAt())
			f.committed()
			f.begin(writePath("delete")...)
			r, err := f.svc.Delete(f.ctx, f.principal, strings.ToUpper(h.ProjectID), strings.ToUpper(h.ID), tc.target, DeleteTaskStep{Version: h.Version})
			f.end()
			expectReceipt(t, r, err, true)
			h.Version++
			assertOrderedResource(t, r.Resource, h, expected)
			if !reflect.DeepEqual(candidate, expected) {
				t.Fatal("Delete encoder changed candidate rows")
			}
			if !reflect.DeepEqual(current, before) {
				t.Fatal("Delete mutated source rows")
			}
			if len(candidate) == 0 && !strings.Contains(string(r.JSON), `"steps":[]`) {
				t.Fatalf("empty collection encoded incorrectly: %s", r.JSON)
			}
		})
		current = orderStepRows(t, original, tc.order)
	}
}

func TestTaskStepsDeleteMissingStaleExhaustionAndLocalIdentity(t *testing.T) {
	for _, version := range []int64{9007199254740993, math.MaxInt64} {
		for _, tc := range []struct {
			name, id, code string
			requested      int64
		}{
			{"stale missing", "ffffffff", "version_conflict", version - 1}, {"current missing", "ffffffff", "not_found", version}, {"exhausted", "00000000", "version_exhausted", version},
		} {
			if tc.code == "version_exhausted" && version != math.MaxInt64 {
				continue
			}
			t.Run(fmt.Sprintf("%s/%d", tc.name, version), func(t *testing.T) {
				h := writeHeader(version)
				rows := orderedStepRows()
				before := slices.Clone(rows)
				f := newOrderedWrite(t, h, rows)
				f.target = tc.id
				stop := "admit"
				if tc.code == "version_conflict" {
					stop = "header"
				} else if tc.code == "not_found" {
					f.admitErr = orderedMissing(version)
				} else {
					f.admitErr = orderedFault(tc.code, nil)
				}
				f.rejected()
				f.begin(writePath(stop)...)
				r, err := f.svc.Delete(f.ctx, f.principal, h.ProjectID, h.ID, tc.id, DeleteTaskStep{Version: tc.requested})
				f.end()
				expectOrderedRefusal(t, r, err, tc.code)
				if r.Changed || !reflect.DeepEqual(rows, before) {
					t.Fatal("Delete refusal changed rows")
				}
				if tc.code == "not_found" {
					var absent *tasksteps.StepAbsence
					if !errors.As(err, &absent) || absent.Version != version || !errors.Is(err, tasksteps.ErrTargetNotFound) {
						t.Fatal("target absence lost admitted version/cause")
					}
				}
			})
		}
	}
	h := writeHeader(2)
	f := newOrderedWrite(t, h, orderedStepRows())
	deleted := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	f.header.DeletedAt = &deleted
	f.rejected()
	f.begin(writePath("header")...)
	r, err := f.svc.Delete(f.ctx, f.principal, h.ProjectID, h.ID, "ffffffff", DeleteTaskStep{Version: 1})
	f.end()
	expectOrderedRefusal(t, r, err, "task_deleted")
}

func TestTaskStepsDeleteReleasesIdentityForANewRecord(t *testing.T) {
	h := writeHeader(2)
	original := orderedStepRows()
	current := orderStepRows(t, original, []string{"00000000", "11111111", "fedcba98"})
	for _, version := range []int64{1, 2} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			f := newOrderedWrite(t, h, current)
			f.target = "abcdef01"
			stop, code := "header", "version_conflict"
			if version == 2 {
				stop, code = "admit", "not_found"
				f.admitErr = orderedMissing(2)
			}
			f.rejected()
			f.begin(writePath(stop)...)
			r, err := f.svc.Delete(f.ctx, f.principal, h.ProjectID, h.ID, "abcdef01", DeleteTaskStep{Version: version})
			f.end()
			expectOrderedRefusal(t, r, err, code)
			if version == 2 {
				var absent *tasksteps.StepAbsence
				if !errors.As(err, &absent) || absent.Version != 2 {
					t.Fatal("missing ID lost version")
				}
			}
		})
	}
	before := slices.Clone(current)
	f := newOrderedWrite(t, h, current)
	f.addStep = model.TaskStep{ID: "abcdef01", Title: "New record", Status: model.TaskStepTodo}
	candidate := append(slices.Clone(current), f.addStep)
	candidate[3].Position = 3
	f.mutation = tasksteps.Mutation{Candidate: candidate, To: 3, Changed: true}
	written := candidate[3]
	written.CreatedAt = orderedAt()
	written.UpdatedAt = orderedAt()
	expected := append(slices.Clone(before), written)
	f.changed(written, orderedAt(), "created", nil, "", "")
	f.committed()
	f.begin(writePath("insert")...)
	r, err := f.svc.Add(f.ctx, f.principal, strings.ToUpper(h.ProjectID), strings.ToUpper(h.ID), AddTaskStep{Version: 2, ID: "ABCDEF01", Title: "New record"})
	f.end()
	expectReceipt(t, r, err, true)
	if !reflect.DeepEqual(candidate, expected) {
		t.Fatal("Add encoder changed survivor rows or fresh record")
	}
	post := h
	post.Version++
	assertOrderedResource(t, r.Resource, post, expected)
	if !reflect.DeepEqual(current, before) || written.CreatedAt == original[2].CreatedAt || written.UpdatedAt == original[2].UpdatedAt {
		t.Fatal("new record reused old data or mutated current")
	}
}

func TestTaskStepsDeleteAdmissionAndStorageFailuresStayExplicit(t *testing.T) {
	h := writeHeader(1)
	for _, tc := range []struct {
		name, project, task, target string
		version                     int64
	}{
		{"principal", h.ProjectID, h.ID, "00000000", 1}, {"project", "bad", h.ID, "00000000", 1}, {"task", h.ProjectID, "bad", "00000000", 1}, {"target", h.ProjectID, h.ID, "bad", 1}, {"version", h.ProjectID, h.ID, "00000000", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newOrderedWrite(t, h, orderedStepRows())
			p := f.principal
			code := "invalid_input"
			if tc.name == "principal" {
				p = model.Principal{}
				code = "unauthenticated"
			}
			f.begin()
			r, err := f.svc.Delete(f.ctx, p, tc.project, tc.task, tc.target, DeleteTaskStep{Version: tc.version})
			f.end()
			expectOrderedRefusal(t, r, err, code)
		})
	}
	for _, stage := range []string{"project", "task", "permission", "collection"} {
		t.Run(stage, func(t *testing.T) {
			rows := orderedStepRows()
			if stage == "collection" {
				rows[2].Position = 9
			}
			f := newOrderedWrite(t, h, rows)
			f.target = "00000000"
			cause := errors.New("corrupt collection")
			stop := "admit"
			switch stage {
			case "project":
				f.startErr = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
				stop = "store"
			case "task":
				f.headerErr = model.ErrNotFound
				stop = "header"
			case "permission":
				f.authErr = orderedFault("not_found", model.ErrNotFound)
				stop = "auth"
			case "collection":
				f.admitErr = cause
			}
			if stage == "project" {
				f.completion = func(err error) (store.Completion, error) {
					if err != f.startErr {
						t.Fatal("start error changed")
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
			} else {
				f.rejected()
			}
			f.begin(writePath(stop)...)
			r, err := f.svc.Delete(f.ctx, f.principal, h.ProjectID, h.ID, f.target, DeleteTaskStep{Version: 1})
			f.end()
			if stage == "collection" {
				expectOrderedInternal(t, r, err, cause)
			} else {
				expectOrderedRefusal(t, r, err, "not_found")
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("not-found cause lost")
				}
			}
		})
	}
}

func TestTaskStepsDeleteQueryFailuresRemainInternal(t *testing.T) {
	for _, stage := range []string{"header", "rows", "writer"} {
		t.Run(stage, func(t *testing.T) {
			h := writeHeader(1)
			f := newOrderedWrite(t, h, orderedStepRows())
			f.target = "00000000"
			cause := errors.New(stage + " storage failure")
			stop := stage
			switch stage {
			case "header":
				f.headerErr = cause
			case "rows":
				f.rowsErr = cause
			case "writer":
				f.startErr = cause
				stop = "store"
			}
			if stage == "writer" {
				f.completion = func(err error) (store.Completion, error) {
					if err != cause {
						t.Fatal("writer cause changed")
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
			} else {
				f.rejected()
			}
			f.begin(writePath(stop)...)
			r, err := f.svc.Delete(f.ctx, f.principal, h.ProjectID, h.ID, f.target, DeleteTaskStep{Version: 1})
			f.end()
			expectOrderedInternal(t, r, err, cause)
		})
	}
}
