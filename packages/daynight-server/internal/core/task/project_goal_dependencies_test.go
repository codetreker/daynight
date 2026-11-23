package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type projectGoalRemovalPlan struct {
	t                       *testing.T
	found                   bool
	probeErr, removeErr     error
	probeCalls, removeCalls int
	deleting                bool
}

func (p *projectGoalRemovalPlan) LockTeam(context.Context) error {
	p.t.Fatal("core must use the existing graph lock")
	return nil
}
func (p *projectGoalRemovalPlan) HasProjectEdges(context.Context) (bool, error) {
	p.probeCalls++
	return p.found, p.probeErr
}
func (p *projectGoalRemovalPlan) RemoveProjectEdges(_ context.Context, deletingProject bool) error {
	p.removeCalls++
	p.deleting = deletingProject
	return p.removeErr
}

func TestRemoveProjectGoalDependencies(t *testing.T) {
	cause := errors.New("database failure")
	for _, c := range []struct {
		name                              string
		confirmed, found, deletingProject bool
		probeErr, removeErr               error
		code                              string
		wantErr                           error
		probes, removes                   int
	}{
		{name: "unconfirmed empty", probes: 1},
		{name: "unconfirmed relationships", found: true, code: "invalid_input", probes: 1},
		{name: "probe failure", probeErr: cause, wantErr: cause, probes: 1},
		{name: "confirmed removal", confirmed: true, removes: 1},
		{name: "confirmed project deletion", confirmed: true, deletingProject: true, removes: 1},
		{name: "removal failure", confirmed: true, removeErr: cause, wantErr: cause, removes: 1},
	} {
		t.Run(c.name, func(t *testing.T) {
			p := &projectGoalRemovalPlan{t: t, found: c.found, probeErr: c.probeErr, removeErr: c.removeErr}
			err := RemoveProjectGoalDependencies(t.Context(), p, c.confirmed, c.deletingProject)
			if c.code != "" {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != c.code {
					t.Fatalf("error %v", err)
				}
			} else if !errors.Is(err, c.wantErr) {
				t.Fatalf("error %v want %v", err, c.wantErr)
			}
			if p.removeCalls != 0 && p.deleting != c.deletingProject {
				t.Fatal("lost Project deletion intent")
			}
			if p.probeCalls != c.probes || p.removeCalls != c.removes {
				t.Fatalf("calls probe=%d removal=%d", p.probeCalls, p.removeCalls)
			}
		})
	}
}
