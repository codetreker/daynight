package session_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sync"
	"testing"

	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
)

type routeBackend struct {
	t         *testing.T
	mu        sync.Mutex
	Funcs     sessionhttp.ServiceCallsForTest
	Calls     sessionhttp.ServiceCallsForTest
	calls     map[string]int
	expected  map[string]int
	repeated  map[string]bool
	minimum   map[string]int
	OnFailure func(error)
}

func newRouteBackend(t *testing.T) *routeBackend {
	t.Helper()
	b := &routeBackend{t: t, calls: map[string]int{}, expected: map[string]int{}, repeated: map[string]bool{}, minimum: map[string]int{}}
	b.Calls = b.wrappedCalls()
	t.Cleanup(func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		functions := reflect.ValueOf(b.Funcs)
		names := functions.Type()
		for i := range functions.NumField() {
			name := names.Field(i).Name
			count, explicit := b.expected[name]
			if !explicit && !functions.Field(i).IsNil() && !b.repeated[name] {
				count, explicit = 1, true
			}
			if explicit && b.calls[name] != count {
				t.Errorf("%s calls = %d, want %d", name, b.calls[name], count)
			}
			if b.calls[name] < b.minimum[name] {
				t.Errorf("%s calls = %d, want at least %d", name, b.calls[name], b.minimum[name])
			}
		}
	})
	return b
}

func (b *routeBackend) requireMethod(name string) {
	b.t.Helper()
	field, ok := reflect.TypeOf(sessionhttp.ServiceCallsForTest{}).FieldByName(name)
	if !ok || field.Type.Kind() != reflect.Func {
		b.t.Fatalf("unknown route usecase %q", name)
	}
}

func (b *routeBackend) Configure(configure func(*sessionhttp.ServiceCallsForTest)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	configure(&b.Funcs)
}
func (b *routeBackend) ExpectCalls(name string, count int) {
	b.t.Helper()
	b.requireMethod(name)
	if count < 0 {
		b.t.Fatal("negative usecase call count")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.expected[name] = count
}
func (b *routeBackend) AllowRepeated(name string) {
	b.requireMethod(name)
	b.mu.Lock()
	defer b.mu.Unlock()
	b.repeated[name] = true
}
func (b *routeBackend) RequireCalls(name string, count int) {
	b.t.Helper()
	b.requireMethod(name)
	if count < 0 {
		b.t.Fatal("negative required usecase calls")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.repeated[name] = true
	b.minimum[name] = count
}
func (b *routeBackend) Called(name string) int {
	b.requireMethod(name)
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls[name]
}
func (b *routeBackend) TotalCalls() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	count := 0
	for _, calls := range b.calls {
		count += calls
	}
	return count
}

func (b *routeBackend) check(name string, configured bool) error {
	b.t.Helper()
	b.mu.Lock()
	b.calls[name]++
	count := b.calls[name]
	allowed, exact := b.expected[name]
	if !exact {
		allowed = 1
	}
	repeated := b.repeated[name] && !exact
	onFailure := b.OnFailure
	b.mu.Unlock()
	if !configured || !repeated && count > allowed {
		err := fmt.Errorf("unexpected usecase %s call: configured=%t, calls=%d, allowed=%d", name, configured, count, allowed)
		b.t.Error(err)
		if onFailure != nil {
			onFailure(err)
		}
		return err
	}
	return nil
}

func routeCopy[T any](value T) T {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var copy T
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	return copy
}
