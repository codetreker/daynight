package oauth

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAuthorizationPruneUsesBoundedBatchesAndConfirmedTotals(t *testing.T) {
	for _, mode := range []string{"negative", "zero", "two retained rows", "short batch", "2000 cap", "second callback error", "second unknown", "second writer error"} {
		t.Run(mode, func(t *testing.T) {
			f := newOAuthFixture(t)
			s := f.service()
			failure := errors.New("cleanup failed")
			budget := 151
			amounts := []int{100, 51}
			limits := []int{100, 51}
			wantTotal := 151
			wantErr := error(nil)
			switch mode {
			case "negative":
				budget = -1
				amounts = nil
				limits = nil
				wantTotal = 0
			case "zero":
				budget = 0
				amounts = nil
				limits = nil
				wantTotal = 0
			case "two retained rows":
				budget = 100
				amounts = []int{2}
				limits = []int{100}
				wantTotal = 2
			case "short batch":
				amounts = []int{40}
				limits = []int{100}
				wantTotal = 40
			case "2000 cap":
				budget = 5000
				amounts = make([]int, 20)
				limits = make([]int, 20)
				for i := range amounts {
					amounts[i] = 100
					limits[i] = 100
				}
				wantTotal = 2000
			case "second callback error", "second writer error":
				wantTotal = 100
				wantErr = failure
			case "second unknown":
				wantTotal = 100
				wantErr = core.ErrAuthorizationUnknown
			}
			for i := range amounts {
				run := !(mode == "second writer error" && i == 1)
				f.steps = append(f.steps, "writer authorization")
				if run {
					f.steps = append(f.steps, "scope authorization", "prune", "callback returned")
				}
				f.steps = append(f.steps, "writer returned")
				callbackErr, finalErr := error(nil), error(nil)
				outcome := store.TransactionCommitted
				if i == 1 {
					switch mode {
					case "second callback error":
						callbackErr = failure
						finalErr = failure
					case "second writer error":
						finalErr = failure
					case "second unknown":
						outcome = store.TransactionUnknown
						finalErr = failure
					}
				}
				f.plan("authorization", run, callbackErr, outcome, finalErr)
			}
			calls := 0
			s.operations.prune = func(ctx context.Context, dao store.AuthorizationDAO, now time.Time, limit int) (int, error) {
				f.context(ctx)
				f.step("prune")
				if !f.active || dao != f.authorization {
					t.Fatal("cleanup used wrong scope capability")
				}
				f.equal(now, f.now)
				f.equal(limit, limits[calls])
				n := amounts[calls]
				calls++
				if mode == "second callback error" && calls == 2 {
					return 0, failure
				}
				return n, nil
			}
			got, err := s.PruneAuthorizations(f.ctx, budget)
			f.equal(got, wantTotal)
			if mode == "negative" {
				if err == nil {
					t.Fatal("negative budget accepted")
				}
			} else {
				checkAuthorizationError(t, err, wantErr)
			}
		})
	}
}
