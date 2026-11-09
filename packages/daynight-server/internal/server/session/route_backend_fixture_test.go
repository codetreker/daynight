package session_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type routeInputKey struct{}
type routePlanKey struct{}
type routeScopeKey struct{}

const routePlanHeader = "Daynight-Test-Scopes"

type routeContract struct {
	maximum int
	name    string
	calls   map[string]int
	input   func() any
	repeat  bool
	minimum int
	outcome func(context.Context, error) (store.Completion, error)
}

type routePlan struct {
	backend  *routeBackend
	mu       sync.Mutex
	names    []string
	used     map[string]int
	finished bool
}

type routeBackend struct {
	t            *testing.T
	DAO          *routeDAO
	mu           sync.Mutex
	contracts    map[string]*routeContract
	background   *routePlan
	plans        []*routePlan
	calls        map[string]int
	OnFailure    func(error)
	CompletionFn func(context.Context, error) (store.Completion, error)
}

func newRouteBackend(t *testing.T) *routeBackend {
	b := &routeBackend{t: t, DAO: &routeDAO{}, contracts: map[string]*routeContract{}, calls: map[string]int{}}
	b.DAO.backend = b
	b.CompletionFn = func(_ context.Context, err error) (store.Completion, error) {
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Cause: err, Outcome: store.TransactionNotCommitted}
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	t.Cleanup(func() {
		for _, plan := range b.plans {
			b.finish(plan)
		}
	})
	return b
}

func (b *routeBackend) Declare(name string, calls map[string]int, input func() any, repeat bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if input == nil {
		panic("unconfigured route input factory " + name)
	}
	if _, exists := b.contracts[name]; exists {
		panic("duplicate route scope contract " + name)
	}
	clone := make(map[string]int, len(calls))
	for method, count := range calls {
		if count < 0 {
			panic("negative scope count")
		}
		clone[method] = count
	}
	minimum, maximum := 1, 1
	if repeat {
		minimum, maximum = 0, -1
	}
	b.contracts[name] = &routeContract{name: name, calls: clone, input: input, repeat: repeat, minimum: minimum, maximum: maximum}
}

func (b *routeBackend) Require(name string, count int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	contract := b.contracts[name]
	if contract == nil || count < 0 {
		panic("unknown or invalid required contract")
	}
	contract.minimum = count
}

func (b *routeBackend) ExpectUses(name string, count int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	contract := b.contracts[name]
	if contract == nil || count < 0 {
		panic("unknown or invalid exact scope uses")
	}
	contract.minimum, contract.maximum = count, count
}

func (b *routeBackend) Outcome(name string, fn func(context.Context, error) (store.Completion, error)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	contract := b.contracts[name]
	if contract == nil || fn == nil {
		panic("unknown or unconfigured route outcome")
	}
	contract.outcome = fn
}

func (b *routeBackend) Configure(fn func(*routeDAO)) { b.mu.Lock(); defer b.mu.Unlock(); fn(b.DAO) }

func (b *routeBackend) Plan(ctx context.Context, names ...string) context.Context {
	plan := b.newPlan(names)
	return context.WithValue(ctx, routePlanKey{}, plan)
}

func (b *routeBackend) newPlan(names []string) *routePlan {
	b.mu.Lock()
	seen := map[string]bool{}
	for _, name := range names {
		if b.contracts[name] == nil || seen[name] {
			b.mu.Unlock()
			b.fail(fmt.Errorf("unconfigured or repeated route scope plan %s", name))
		}
		seen[name] = true
	}
	plan := &routePlan{backend: b, names: append([]string(nil), names...), used: map[string]int{}}
	b.plans = append(b.plans, plan)
	b.mu.Unlock()
	return plan
}

func (b *routeBackend) PlanHeader(names ...string) http.Header {
	header := make(http.Header)
	header.Set(routePlanHeader, strings.Join(names, ","))
	return header
}

func (b *routeBackend) Background(names ...string) {
	plan := b.newPlan(names)
	b.mu.Lock()
	b.background = plan
	b.mu.Unlock()
}

func (b *routeBackend) Finish(ctx context.Context) {
	if plan, ok := ctx.Value(routePlanKey{}).(*routePlan); ok {
		b.finish(plan)
	}
}

func (b *routeBackend) finish(plan *routePlan) {
	plan.mu.Lock()
	defer plan.mu.Unlock()
	if plan.finished {
		return
	}
	plan.finished = true
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, name := range plan.names {
		contract := b.contracts[name]
		if plan.used[name] < contract.minimum || contract.maximum >= 0 && plan.used[name] > contract.maximum {
			b.t.Errorf("route scope %s used %d times, want at least %d", name, plan.used[name], contract.minimum)
		}
	}
}

func routeCopy[T any](value T) T {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var result T
	if err := json.Unmarshal(raw, &result); err != nil {
		panic(err)
	}
	return result
}

func routeInputFor[T any](ctx context.Context) T {
	input, ok := ctx.Value(routeInputKey{}).(T)
	if !ok {
		panic("route scope input has unexpected type")
	}
	return input
}

func routeScopeToken(ctx context.Context) *routeCallScope {
	scope, ok := ctx.Value(routeScopeKey{}).(*routeCallScope)
	if !ok {
		panic("route scope observer unavailable")
	}
	return scope
}

func routeProfileFor(ctx context.Context) string {
	scope := routeScopeToken(ctx)
	scope.mu.Lock()
	defer scope.mu.Unlock()
	if len(scope.candidates) != 1 {
		return ""
	}
	return scope.candidates[0].contract.name
}

type routeCandidate struct {
	maximum   int
	outcome   func(context.Context, error) (store.Completion, error)
	contract  *routeContract
	remaining map[string]int
	input     any
}
type routeCallScope struct {
	mu          sync.Mutex
	closed      bool
	initialized bool
	observed    []string
	backend     *routeBackend
	plan        *routePlan
	candidates  []*routeCandidate
}

func (b *routeBackend) fail(err error) {
	b.t.Helper()
	b.t.Error(err)
	b.mu.Lock()
	onFailure := b.OnFailure
	b.mu.Unlock()
	if onFailure != nil {
		onFailure(err)
	}
	panic(err)
}

func (b *routeBackend) Called(name string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls[name]
}

func (b *routeBackend) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	b.mu.Lock()
	b.calls["WriteSession"]++
	b.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	plan, ok := ctx.Value(routePlanKey{}).(*routePlan)
	if !ok {
		b.mu.Lock()
		plan = b.background
		b.mu.Unlock()
	}
	if plan == nil || plan.backend != b {
		b.fail(fmt.Errorf("unconfigured route transaction"))
	}
	plan.mu.Lock()
	if plan.finished {
		plan.mu.Unlock()
		b.fail(fmt.Errorf("route scope plan already completed"))
	}
	if len(plan.names) == 0 {
		plan.mu.Unlock()
		b.fail(fmt.Errorf("route transaction has no enabled contract"))
	}
	b.mu.Lock()
	dao := *b.DAO
	b.mu.Unlock()
	plan.mu.Unlock()
	scope := &routeCallScope{backend: b, plan: plan}
	dao.scope = scope
	defer scope.close()
	err := work(routeStoreScope{dao: &dao})
	outcome := scope.complete()
	ctx = context.WithValue(ctx, routeScopeKey{}, scope)
	if outcome != nil {
		return outcome(ctx, err)
	}
	return b.CompletionFn(ctx, err)
}

type routeStoreScope struct{ dao *routeDAO }

func (s routeStoreScope) SessionDAO() store.SessionDAO { s.dao.scope.requireOpen(); return s.dao }
func (s routeStoreScope) BotDAO() store.BotWriteDAO {
	s.dao.scope.requireOpen()
	return routeUnavailableBotDAO{scope: s.dao.scope}
}

func (s *routeCallScope) requireOpen() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		s.backend.fail(fmt.Errorf("route DAO scope already closed"))
	}
}

// A scope's enabled contracts and read facts form one snapshot. They are
// selected at the first DAO call so an admitted timer tick cannot mix a prior
// intent budget with facts selected while its callback was waiting.
func (s *routeCallScope) initialize(first string) error {
	s.plan.mu.Lock()
	defer s.plan.mu.Unlock()
	s.backend.mu.Lock()
	defer s.backend.mu.Unlock()
	enabled := false
	for _, name := range s.plan.names {
		contract := s.backend.contracts[name]
		if contract.maximum >= 0 && s.plan.used[name] >= contract.maximum {
			continue
		}
		enabled = true
		if first != "" && contract.calls[first] == 0 {
			continue
		}
		remaining := make(map[string]int, len(contract.calls))
		for method, count := range contract.calls {
			remaining[method] = count
		}
		candidate := &routeCandidate{contract: contract, remaining: remaining, outcome: contract.outcome, maximum: contract.maximum}
		if first != "" {
			candidate.input = contract.input()
		}
		s.candidates = append(s.candidates, candidate)
	}
	s.initialized = true
	if !enabled {
		return fmt.Errorf("route transaction has no enabled contract")
	}
	if len(s.candidates) == 0 {
		return fmt.Errorf("unexpected route DAO call %s", first)
	}
	return nil
}

func (s *routeCallScope) invoke(ctx context.Context, name string, configured bool) context.Context {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		s.backend.fail(fmt.Errorf("route DAO scope already closed: %s", name))
	}
	if !configured {
		s.backend.fail(fmt.Errorf("unconfigured route DAO call %s", name))
	}
	if !s.initialized {
		if err := s.initialize(name); err != nil {
			s.backend.fail(err)
		}
	}
	var next []*routeCandidate
	for _, candidate := range s.candidates {
		if candidate.remaining[name] > 0 {
			candidate.remaining[name]--
			next = append(next, candidate)
		}
	}
	if len(next) == 0 {
		s.backend.fail(fmt.Errorf("unexpected route DAO call %s", name))
	}

	input := next[0].input
	for _, candidate := range next[1:] {
		if !reflect.DeepEqual(input, candidate.input) {
			s.backend.fail(fmt.Errorf("ambiguous route input before %s", name))
		}
	}
	s.candidates = next
	s.observed = append(s.observed, name)
	s.backend.mu.Lock()
	s.backend.calls[name]++
	s.backend.mu.Unlock()
	ctx = context.WithValue(ctx, routeScopeKey{}, s)
	return context.WithValue(ctx, routeInputKey{}, input)
}

func (s *routeCallScope) close() { s.mu.Lock(); defer s.mu.Unlock(); s.closed = true }

func (s *routeCallScope) complete() func(context.Context, error) (store.Completion, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if !s.initialized {
		if err := s.initialize(""); err != nil {
			s.backend.fail(err)
		}
	}
	var matched []*routeCandidate
	for _, candidate := range s.candidates {
		complete := true
		for _, count := range candidate.remaining {
			if count != 0 {
				complete = false
				break
			}
		}
		if complete {
			matched = append(matched, candidate)
		}
	}
	if len(matched) != 1 {
		remaining := map[string]map[string]int{}
		for _, candidate := range s.candidates {
			remaining[candidate.contract.name] = candidate.remaining
		}
		s.backend.fail(fmt.Errorf("route transaction matches %d complete contracts; observed %v; remaining %v", len(matched), s.observed, remaining))
	}
	s.candidates = matched
	contract := matched[0].contract
	s.plan.mu.Lock()
	defer s.plan.mu.Unlock()
	if matched[0].maximum >= 0 && s.plan.used[contract.name] >= matched[0].maximum {
		s.backend.fail(fmt.Errorf("extra route scope %s", contract.name))
	}
	s.plan.used[contract.name]++
	return matched[0].outcome
}
